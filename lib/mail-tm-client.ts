const MAIL_TM_API = "https://api.mail.tm"

export type MailTmAccount = {
  id: string
  address: string
  password: string
  token: string
}

type MailTmDomainResponse = {
  "hydra:member"?: Array<{
    domain?: string
    isActive?: boolean
  }>
}

type MailTmMessageSummary = {
  id: string
  subject?: string
  intro?: string
  seen?: boolean
  from?: {
    name?: string
    address?: string
  }
  createdAt?: string
}

type MailTmMessage = MailTmMessageSummary & {
  text?: string
  html?: string | string[]
  to?: Array<{
    name?: string
    address?: string
  }>
}

function randomPassword() {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*"
  const values = new Uint32Array(32)

  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(values)
    return Array.from(values, (value) => alphabet[value % alphabet.length]).join(
      "",
    )
  }

  return \`\${Date.now()}-\${Math.random().toString(36).slice(2)}\`
}

async function parseError(response: Response) {
  try {
    const body = (await response.json()) as { message?: string; detail?: string }
    return body.message || body.detail || \`Mail.tm request failed (\${response.status})\`
  } catch {
    return \`Mail.tm request failed (\${response.status})\`
  }
}

async function request(
  path: string,
  init: RequestInit = {},
  token?: string,
) {
  const headers = new Headers(init.headers)
  headers.set("Accept", "application/json")

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  if (token) {
    headers.set("Authorization", \`Bearer \${token}\`)
  }

  return fetch(\`\${MAIL_TM_API}\${path}\`, {
    ...init,
    headers,
    cache: "no-store",
  })
}

export async function getMailTmDomains() {
  const response = await request("/domains")

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  const data = (await response.json()) as MailTmDomainResponse
  return (data["hydra:member"] ?? [])
    .filter((item) => item.isActive !== false && typeof item.domain === "string")
    .map((item) => item.domain!.toLowerCase())
    .filter(Boolean)
}

async function getToken(address: string, password: string) {
  const response = await request("/token", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  })

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  const data = (await response.json()) as { token?: string; id?: string }

  if (!data.token || !data.id) {
    throw new Error("Mail.tm returned an invalid authentication response.")
  }

  return { token: data.token, id: data.id }
}

export async function createMailTmAccount(
  mailbox: string,
  domain: string,
  attempts = 5,
): Promise<MailTmAccount> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const address = \`\${mailbox}@\${domain}\`
    const password = randomPassword()

    const response = await request("/accounts", {
      method: "POST",
      body: JSON.stringify({ address, password }),
    })

    if (response.ok) {
      const token = await getToken(address, password)
      return {
        id: token.id,
        address,
        password,
        token: token.token,
      }
    }

    const message = await parseError(response)
    lastError = new Error(message)

    if (response.status !== 409 && response.status !== 422) {
      break
    }

    mailbox = \`\${mailbox}-\${Math.floor(100 + Math.random() * 900)}\`.slice(
      0,
      64,
    )
  }

  throw lastError ?? new Error("Unable to create a Mail.tm account.")
}

async function authorizedRequest(
  account: MailTmAccount,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
) {
  const first = await request(
    path,
    { ...init, signal },
    account.token,
  )

  if (first.status !== 401) return first

  const refreshed = await getToken(account.address, account.password)
  account.token = refreshed.token
  account.id = refreshed.id

  return request(path, { ...init, signal }, account.token)
}

export async function listMailTmMessages(
  account: MailTmAccount,
  signal?: AbortSignal,
) {
  const response = await authorizedRequest(account, "/messages", {}, signal)

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  const data = (await response.json()) as {
    "hydra:member"?: MailTmMessageSummary[]
  }

  return (data["hydra:member"] ?? []).map((message) => ({
    id: message.id,
    title: message.subject?.trim() || "(sem assunto)",
    sender:
      message.from?.name && message.from.address
        ? \`\${message.from.name} <\${message.from.address}>\`
        : message.from?.address || message.from?.name || "Remetente desconhecido",
    receivedAt: message.createdAt,
  }))
}

export async function readMailTmMessage(
  account: MailTmAccount,
  id: string,
) {
  const response = await authorizedRequest(
    account,
    \`/messages/\${encodeURIComponent(id)}\`,
  )

  if (!response.ok) {
    throw new Error(await parseError(response))
  }

  const message = (await response.json()) as MailTmMessage

  void authorizedRequest(
    account,
    \`/messages/\${encodeURIComponent(id)}\`,
    { method: "PATCH" },
  ).catch(() => undefined)

  const html = Array.isArray(message.html)
    ? message.html.filter(Boolean).join("")
    : message.html

  return {
    id: message.id,
    receivedAt: message.createdAt,
    content: {
      subject: message.subject?.trim() || "(sem assunto)",
      from: message.from,
      to: message.to,
      text: message.text,
      html,
    },
  }
}
