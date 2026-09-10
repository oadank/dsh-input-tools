/**
 * [本地移植 2026-09-10 · 0.1.5] 原 @anoslide/dsh-host-files 能力并入
 * @oadank/dsh-input-tools：全局人设 / MCP 动态管理 / Skill 管理 / 基础文件 API。
 * 文件 API 仅保留 list/read/write/search（分栏 UI 已放弃，git/highlight/mkdir 等已砍）。
 */
import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"

const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_WRITE_BYTES = 10 * 1024 * 1024
const SEARCH_DEPTH_LIMIT = 8
const SEARCH_ENTRY_LIMIT = 20000
const SEARCH_RESULT_LIMIT = 200
const COLLAPSED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "dist", ".next", ".dsh"])
const PERSONA_FILE = join(homedir(), ".dsh", "global-persona.md")
const MAX_PERSONA_BYTES = 128 * 1024
const PERSONA_SECTION = "user:global-persona"
const PERSONA_ORDER = 1
const MCP_STATE_FILE = join(homedir(), ".dsh", "mcp-servers.json")
const SKILLS_ROOT = join(homedir(), ".dsh", "skills")

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(body)
}

function isHiddenName(name) {
  return name.startsWith(".") || COLLAPSED_DIRS.has(name)
}

function looksBinary(text) {
  const n = text.length
  if (n === 0) return false
  let nul = 0
  for (let i = 0; i < Math.min(n, 8192); i++) if (text.charCodeAt(i) === 0) nul++
  return nul / Math.min(n, 8192) > 0.01
}

function readJsonBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > cap) {
        reject(new Error("request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(new Error("invalid JSON body"))
      }
    })
    req.on("error", reject)
  })
}

async function searchDir(root, q) {
  const needle = q.toLowerCase()
  const out = []
  const budget = { used: 0 }
  async function walk(dir, depth) {
    if (depth > SEARCH_DEPTH_LIMIT || budget.used >= SEARCH_ENTRY_LIMIT || out.length >= SEARCH_RESULT_LIMIT) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= SEARCH_RESULT_LIMIT || budget.used >= SEARCH_ENTRY_LIMIT) return
      if (isHiddenName(entry.name)) continue
      budget.used += 1
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.name.toLowerCase().includes(needle)) {
        out.push({ name: entry.name, path: full, rel: full.slice(root.length + 1).replace(/\\/g, "/") })
      }
    }
  }
  await walk(root, 0)
  return out
}

let rootCtx = null
let mcpClientModulePromise = null
let mcpServers = []
const mcpDisposers = new Map()

function resolveDshModule(name) {
  try {
    return createRequire(import.meta.url).resolve(name)
  } catch {}
  const globalRoot = process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : null
  if (globalRoot) {
    const dshBin = join(globalRoot, "@deepseek-ai", "dsh", "lib", "bin.js")
    if (existsSync(dshBin)) {
      try {
        return createRequire(dshBin).resolve(name)
      } catch {}
    }
  }
  throw new Error(`无法定位 ${name}：请确认全局安装了 @deepseek-ai/dsh`)
}

function loadMCPClientModule() {
  if (mcpClientModulePromise === null) {
    mcpClientModulePromise = (async () => {
      const entry = resolveDshModule("@deepseek-ai/dsh-mcp-client")
      return import(pathToFileURL(entry).href)
    })()
  }
  return mcpClientModulePromise
}

async function loadMCPState() {
  try {
    const raw = JSON.parse(await readFile(MCP_STATE_FILE, "utf8"))
    mcpServers = Array.isArray(raw?.servers) ? raw.servers : []
  } catch {
    mcpServers = []
  }
}

async function saveMCPState() {
  await mkdir(join(homedir(), ".dsh"), { recursive: true })
  await writeFile(MCP_STATE_FILE, JSON.stringify({ version: 1, servers: mcpServers }, null, 2), "utf8")
}

function mcpConfigOf(server) {
  const base = {
    serverName: server.serverName,
    toolCallTimeoutMs: server.toolCallTimeoutMs ?? 30000,
    failOnStartupError: false,
    reconnect: { enabled: false },
  }
  if (server.transport === "streamable-http") {
    return { ...base, transport: "streamable-http", url: server.url, headers: server.headers ?? {} }
  }
  return { ...base, transport: "stdio", command: server.command, args: server.args ?? [], env: server.env ?? {}, cwd: server.cwd ?? "" }
}

async function mountMCPServer(server) {
  try {
    const mod = await loadMCPClientModule()
    if (rootCtx === null) throw new Error("host plugin 尚未初始化")
    const dispose = await rootCtx.plugin(mod, mcpConfigOf(server))
    mcpDisposers.set(server.id, dispose)
  } catch (error) {
    console.error(`[dsh-input-tools] MCP 挂载失败 ${server.serverName}:`, error instanceof Error ? error.message : String(error))
  }
}

async function unmountMCP(id) {
  const dispose = mcpDisposers.get(id)
  if (dispose !== void 0) {
    mcpDisposers.delete(id)
    try {
      await dispose()
    } catch {}
  }
}

function mcpPublicView(server) {
  return {
    id: server.id,
    serverName: server.serverName,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    enabled: server.enabled !== false,
    hasEnv: !!(server.env && Object.keys(server.env).length > 0),
  }
}

async function listSkills() {
  const out = []
  let entries = []
  try {
    entries = await readdir(SKILLS_ROOT, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(SKILLS_ROOT, entry.name)
    if (entry.isDirectory()) {
      if (existsSync(join(full, "SKILL.md"))) out.push({ name: entry.name, path: full, enabled: true, kind: "dir" })
      else if (existsSync(join(full, "SKILL.md.disabled"))) out.push({ name: entry.name, path: full, enabled: false, kind: "dir" })
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".md")) out.push({ name: entry.name, path: full, enabled: true, kind: "file" })
      else if (entry.name.endsWith(".md.disabled")) out.push({ name: entry.name.slice(0, -".disabled".length), path: full, enabled: false, kind: "file" })
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

async function toggleSkill(target) {
  const info = await stat(target)
  if (info.isDirectory()) {
    const on = join(target, "SKILL.md")
    const off = join(target, "SKILL.md.disabled")
    if (existsSync(on)) await rename(on, off)
    else if (existsSync(off)) await rename(off, on)
  } else {
    if (target.endsWith(".disabled")) await rename(target, target.slice(0, -".disabled".length))
    else await rename(target, target + ".disabled")
  }
}

/**
 * Mount persona injection, MCP runtime, skills/files HTTP routes.
 * @param ctx - Cordis host context with systemPrompt + webServer.
 */
export function applyHostFiles(ctx) {
  ctx.inject(["systemPrompt"], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: PERSONA_SECTION,
      order: PERSONA_ORDER,
      text: () => {
        try {
          return readFileSync(PERSONA_FILE, "utf8").slice(0, MAX_PERSONA_BYTES)
        } catch {
          return ""
        }
      },
    })
  })
  rootCtx = ctx
  ctx.effect(() => {
    ;(async () => {
      await loadMCPState()
      for (const server of mcpServers) {
        if (server.enabled !== false) await mountMCPServer(server)
      }
    })()
    return () => {
      for (const id of [...mcpDisposers.keys()]) {
        const dispose = mcpDisposers.get(id)
        mcpDisposers.delete(id)
        try {
          dispose?.()
        } catch {}
      }
    }
  }, "dsh-input-tools: mcp runtime")
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/vscode-files",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x")
      if (url.pathname === "/vscode-files/persona") {
        if (req.method === "POST") {
          try {
            const body = await readJsonBody(req, MAX_PERSONA_BYTES + 4096)
            const content = body?.content
            if (typeof content !== "string") return sendJson(res, 400, { ok: false, error: "body needs { content: string }" })
            if (Buffer.byteLength(content, "utf8") > MAX_PERSONA_BYTES) return sendJson(res, 400, { ok: false, error: "persona too large" })
            await writeFile(PERSONA_FILE, content, "utf8")
            return sendJson(res, 200, { ok: true })
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        }
        let content = ""
        try {
          content = await readFile(PERSONA_FILE, "utf8")
        } catch {}
        return sendJson(res, 200, { ok: true, content })
      }
      if (url.pathname === "/vscode-files/skills" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, skills: await listSkills() })
      }
      if (url.pathname === "/vscode-files/mcp" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, servers: mcpServers.map(mcpPublicView) })
      }
      if (url.pathname === "/vscode-files/skills/toggle" || url.pathname === "/vscode-files/skills/delete"
        || url.pathname === "/vscode-files/mcp/toggle" || url.pathname === "/vscode-files/mcp/delete"
        || url.pathname === "/vscode-files/mcp/add" || url.pathname === "/vscode-files/mcp/update") {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" })
        try {
          const body = await readJsonBody(req, 64 * 1024)
          if (url.pathname === "/vscode-files/skills/toggle") {
            const target = body?.path
            if (typeof target !== "string" || target.length === 0) return sendJson(res, 400, { ok: false, error: "body needs { path }" })
            await toggleSkill(target)
            return sendJson(res, 200, { ok: true })
          }
          if (url.pathname === "/vscode-files/skills/delete") {
            const target = body?.path
            if (typeof target !== "string" || target.length === 0) return sendJson(res, 400, { ok: false, error: "body needs { path }" })
            // 删除走重命名到 .deleted，避免 PowerShell recycle 在无 UI 会话挂起
            await rename(target, target + ".deleted-" + String(Date.now()))
            return sendJson(res, 200, { ok: true })
          }
          if (url.pathname === "/vscode-files/mcp/toggle") {
            const server = mcpServers.find((s) => s.id === body?.id)
            if (server === void 0) return sendJson(res, 404, { ok: false, error: "server not found" })
            server.enabled = !(server.enabled !== false)
            if (server.enabled) void mountMCPServer(server)
            else await unmountMCP(server.id)
            await saveMCPState()
            return sendJson(res, 200, { ok: true, enabled: server.enabled })
          }
          if (url.pathname === "/vscode-files/mcp/delete") {
            await unmountMCP(body?.id)
            mcpServers = mcpServers.filter((s) => s.id !== body?.id)
            await saveMCPState()
            return sendJson(res, 200, { ok: true })
          }
          if (url.pathname === "/vscode-files/mcp/add") {
            const serverName = body?.serverName
            const transport = body?.transport === "streamable-http" ? "streamable-http" : "stdio"
            if (typeof serverName !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
              return sendJson(res, 400, { ok: false, error: "serverName 需为 1-32 位字母/数字/_-" })
            }
            if (mcpServers.some((s) => s.id === serverName)) return sendJson(res, 400, { ok: false, error: "serverName 已存在" })
            if (transport === "stdio") {
              if (typeof body?.command !== "string" || body.command.length === 0) return sendJson(res, 400, { ok: false, error: "stdio 类型需要 command" })
            } else if (typeof body?.url !== "string" || body.url.length === 0) {
              return sendJson(res, 400, { ok: false, error: "streamable-http 类型需要 url" })
            }
            const server = {
              id: serverName,
              serverName,
              transport,
              command: body?.command ?? "",
              args: Array.isArray(body?.args) ? body.args.map(String) : [],
              env: body?.env && typeof body.env === "object" ? Object.fromEntries(Object.entries(body.env).map(([k, v]) => [k, String(v)])) : {},
              url: body?.url ?? "",
              headers: body?.headers && typeof body.headers === "object" ? Object.fromEntries(Object.entries(body.headers).map(([k, v]) => [k, String(v)])) : {},
              enabled: true,
            }
            mcpServers.push(server)
            void mountMCPServer(server)
            await saveMCPState()
            return sendJson(res, 200, { ok: true, id: serverName })
          }
          if (url.pathname === "/vscode-files/mcp/update") {
            const server = mcpServers.find((s) => s.id === body?.id)
            if (server === void 0) return sendJson(res, 404, { ok: false, error: "server not found" })
            const transport = body?.transport === "streamable-http" ? "streamable-http" : "stdio"
            if (transport === "stdio") {
              if (typeof body?.command !== "string" || body.command.length === 0) return sendJson(res, 400, { ok: false, error: "stdio 类型需要 command" })
            } else if (typeof body?.url !== "string" || body.url.length === 0) {
              return sendJson(res, 400, { ok: false, error: "streamable-http 类型需要 url" })
            }
            server.transport = transport
            server.command = body?.command ?? ""
            server.args = Array.isArray(body?.args) ? body.args.map(String) : []
            server.env = body?.env && typeof body.env === "object" ? Object.fromEntries(Object.entries(body.env).map(([k, v]) => [k, String(v)])) : {}
            server.url = body?.url ?? ""
            server.headers = body?.headers && typeof body.headers === "object" ? Object.fromEntries(Object.entries(body.headers).map(([k, v]) => [k, String(v)])) : {}
            await unmountMCP(server.id)
            if (server.enabled) void mountMCPServer(server)
            await saveMCPState()
            return sendJson(res, 200, { ok: true })
          }
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
      // 基础文件 API：list / read / write / search
      const target = url.searchParams.get("path")
      if (typeof target !== "string" || target.length === 0) {
        return sendJson(res, 400, { ok: false, error: "missing path" })
      }
      try {
        if (url.pathname === "/vscode-files/list") {
          const entries = await readdir(target, { withFileTypes: true })
          const dirs = []
          const files = []
          for (const entry of entries) {
            const full = join(target, entry.name)
            const hidden = isHiddenName(entry.name)
            if (entry.isDirectory()) dirs.push({ name: entry.name, path: full, hidden })
            else if (entry.isFile()) {
              let size = 0
              let mtimeMs = 0
              try {
                const info = await stat(full)
                size = info.size
                mtimeMs = info.mtimeMs
              } catch {}
              files.push({ name: entry.name, path: full, size, mtimeMs, hidden })
            }
          }
          dirs.sort((a, b) => a.name.localeCompare(b.name))
          files.sort((a, b) => a.name.localeCompare(b.name))
          return sendJson(res, 200, { ok: true, path: target, dirs, files })
        }
        if (url.pathname === "/vscode-files/read") {
          const info = await stat(target)
          if (info.isDirectory()) return sendJson(res, 400, { ok: false, error: "path is a directory" })
          if (info.size > MAX_READ_BYTES) {
            const text = await readFile(target, "utf8")
            return sendJson(res, 200, { ok: true, kind: "too-large", content: text.slice(0, MAX_READ_BYTES), size: info.size })
          }
          const text = await readFile(target, "utf8")
          if (looksBinary(text)) return sendJson(res, 200, { ok: true, kind: "binary", content: "", size: info.size })
          return sendJson(res, 200, { ok: true, kind: "text", content: text, size: info.size })
        }
        if (url.pathname === "/vscode-files/search") {
          const q = url.searchParams.get("q")
          if (typeof q !== "string" || q.trim().length === 0) return sendJson(res, 400, { ok: false, error: "missing q" })
          return sendJson(res, 200, { ok: true, results: await searchDir(target, q.trim()) })
        }
        if (req.method === "POST" && url.pathname === "/vscode-files/write") {
          let body
          try {
            body = await readJsonBody(req, 12 * 1024 * 1024)
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message })
          }
          const writePath = body?.path
          const content = body?.content
          if (typeof writePath !== "string" || writePath.length === 0 || typeof content !== "string") {
            return sendJson(res, 400, { ok: false, error: "body needs { path: string, content: string }" })
          }
          if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
            return sendJson(res, 400, { ok: false, error: "content too large" })
          }
          const info = await stat(writePath).catch(() => void 0)
          if (info !== void 0 && info.isDirectory()) return sendJson(res, 400, { ok: false, error: "path is a directory" })
          await writeFile(writePath, content, "utf8")
          return sendJson(res, 200, { ok: true, size: Buffer.byteLength(content, "utf8") })
        }
        return sendJson(res, 404, { ok: false, error: "unknown vscode-files endpoint (list/read/write/search/persona/skills/mcp only)" })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), "dsh-input-tools: /vscode-files routes")
}
