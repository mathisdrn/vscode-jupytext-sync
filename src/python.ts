// Inspired from https://github.com/parmentelat/vscode-jupytext
import {spawn} from "child_process"
import * as vscode from "vscode"
import {PythonExtension} from "@vscode/python-extension"
import {getJConsole, config} from "./constants"
import {getNewPythonEnvsApi} from "./pythonEnvironmentsApi"
import * as path from "path"
import * as fs from "fs"

export function getPythonFromConfig(): string | undefined {
  let pythonExecutable = config().get<string>("pythonExecutable") ?? undefined
  if (!pythonExecutable) {
    return undefined
  }
  pythonExecutable = expandVariables(pythonExecutable)
  console.debug("pythonExecutable", pythonExecutable)
  return pythonExecutable
}

function expandVariables(value: string): string {
  // ${workspaceFolder}
  if (value.includes("${workspaceFolder}")) {
    value = value.replace(
      /\$\{workspaceFolder\}/g,
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
    )
  }

  // ${userHome}
  const userHome = process.env["HOME"] || process.env["USERPROFILE"] || ""
  if (value.includes("${userHome}")) {
    value = value.replace(/\$\{userHome\}/g, userHome)
  }

  // ${env:VAR_NAME}
  value = value.replace(/\$\{env:([^}]+)\}/g, (_match, varName) => {
    return process.env[varName] ?? ""
  })

  return value
}

export async function resolvePythonExecutable(command: string[]): Promise<string | undefined> {
  const cmdArgs = Array.isArray(command)
    ? command.concat("-c", "import sys; print(sys.executable)")
    : [command, "-c", "import sys; print(sys.executable)"]
  try {
    const output = await runCommand(cmdArgs)
    const msg = `Python '${command}' resolved to: ${output}`
    if (output) {
      getJConsole().appendLine(msg)
      return output
    }
  } catch (ex) {
    const msg = `Failed to check python with '${cmdArgs}': ${ex}`
    console.error(msg, ex)
  }
  return undefined
}

function normalizeCmdArgs(cmdArgs: string[]) {
  return cmdArgs.map((item) => item.replace(/\\/g, "/"))
}

export async function runCommand(cmdArgs: string[], cwd?: string): Promise<string> {
  const [cmd, ...args] = normalizeCmdArgs(cmdArgs)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: process.env["PYTHONIOENCODING"] || "utf-8",
  }
  let spawnEnv = {cwd: cwd || ".", env}

  const cmdStr = `${cmd} ${args.join(" ")}`
  console.debug(`Executing: ${cmdStr}`)
  const proc = spawn(cmd, args, spawnEnv)
  let stdout = ""
  let stderr = ""
  proc.stdout.on("data", (data) => {
    stdout += data.toString("utf8")
  })
  proc.stderr.on("data", (data) => {
    stderr += data.toString("utf8")
  })
  return new Promise<string>((resolve, reject) => {
    proc.on("error", (error: Error) => {
      stderr = stderr.trim()
      stdout = stdout.trim()
      let msg = `'${error}' during '${cmdStr}'`
      if (stderr.length > 0) {
        msg += `\n(stderr): ${stderr}`
      }
      if (stdout.length > 0) {
        msg += `\n(stdout): ${stdout}`
      }
      console.error(msg)
      return reject(stderr)
    })
    proc.on("close", (code: number) => {
      stderr = stderr.trim()
      stdout = stdout.trim()
      let msg = `Exit code '${code}' during '${cmdStr}'`
      if (stderr.length > 0) {
        msg += `\n(stderr): ${stderr}`
      }
      if (stdout.length > 0) {
        msg += `\n(stdout): ${stdout}`
      }
      if (code !== 0) {
        console.error(msg)
        return reject(stderr)
      }
      console.debug(msg)
      resolve(stdout)
    })
  })
}

async function getActiveWorkspaceEnvsViaNewPythonEnvs(resourceUri?: vscode.Uri): Promise<string[]> {
  const api = await getNewPythonEnvsApi()
  if (!api) {
    return []
  }
  try {
    const paths: string[] = []
    const targetFolder = resourceUri
      ? vscode.workspace.getWorkspaceFolder(resourceUri)?.uri
      : vscode.workspace.workspaceFolders?.[0]?.uri
    if (targetFolder) {
      const active = await api.getEnvironment(targetFolder)
      const exe = active?.execInfo?.run?.executable
      if (exe && !active?.error) {
        getJConsole().appendLine(
          `ms-python.vscode-python-envs: workspace active env: ${exe}`,
        )
        paths.push(exe)
      }
    }
    return paths
  } catch (ex) {
    getJConsole().appendLine(`ms-python.vscode-python-envs active env query failed: ${ex}`)
    return []
  }
}

async function getGlobalAndOtherEnvsViaNewPythonEnvs(): Promise<string[]> {
  const api = await getNewPythonEnvsApi()
  if (!api) {
    return []
  }
  try {
    const paths: string[] = []
    const addEnvPath = (env: {execInfo?: {run?: {executable?: string}}; error?: string}) => {
      const exe = env.execInfo?.run?.executable
      if (exe && !env.error && !paths.includes(exe)) {
        paths.push(exe)
      }
    }
    // Global active environment
    const globalActive = await api.getEnvironment(undefined)
    if (globalActive) {
      addEnvPath(globalActive)
    }
    // All other discovered environments, skipping broken ones
    const all = await api.getEnvironments("all")
    for (const env of all) {
      addEnvPath(env)
    }
    return paths
  } catch (ex) {
    getJConsole().appendLine(`ms-python.vscode-python-envs discovery query failed: ${ex}`)
    return []
  }
}

async function getActiveEnvViaMsPython(resourceUri?: vscode.Uri): Promise<string[]> {
  const pythonExt = vscode.extensions.getExtension<PythonExtension>("ms-python.python")
  if (!pythonExt) {
    return []
  }
  try {
    const pythonApi = pythonExt.isActive ? pythonExt.exports : await pythonExt.activate()
    const targetUri = resourceUri ?? vscode.workspace.workspaceFolders?.[0]?.uri
    const activeEnvPath = pythonApi.environments.getActiveEnvironmentPath(targetUri)
    if (activeEnvPath?.path) {
      return [activeEnvPath.path]
    }
  } catch (ex) {
    getJConsole().appendLine(`ms-python.python active env query failed: ${ex}`)
  }
  return []
}

async function getOtherEnvsViaMsPython(): Promise<string[]> {
  const pythonExt = vscode.extensions.getExtension<PythonExtension>("ms-python.python")
  if (!pythonExt) {
    return []
  }
  try {
    const pythonApi = pythonExt.isActive ? pythonExt.exports : await pythonExt.activate()
    const paths: string[] = []
    const knownEnvs = pythonApi.environments.known
    for (const env of knownEnvs) {
      if (env.path && !paths.includes(env.path)) {
        paths.push(env.path)
      }
    }
    return paths
  } catch (ex) {
    getJConsole().appendLine(`ms-python.python known envs query failed: ${ex}`)
  }
  return []
}

export function findWorkspaceVirtualenvs(resourceUri?: vscode.Uri): string[] {
  const paths: string[] = []
  const folders = resourceUri
    ? [vscode.workspace.getWorkspaceFolder(resourceUri)].filter((f): f is vscode.WorkspaceFolder => !!f)
    : vscode.workspace.workspaceFolders ?? []

  const isWin = process.platform === "win32"
  const binDir = isWin ? "Scripts" : "bin"
  const exeName = isWin ? "python.exe" : "python"

  const candidateRelativeDirs = [
    ".venv",
    "venv",
    "env",
    ".conda",
    ".pixi/envs/default",
    ".direnv/python",
  ]

  for (const folder of folders) {
    for (const relDir of candidateRelativeDirs) {
      const candidatePath = path.join(folder.uri.fsPath, relDir, binDir, exeName)
      if (fs.existsSync(candidatePath) && !paths.includes(candidatePath)) {
        paths.push(candidatePath)
      }
    }
  }

  return paths
}

export async function findStandaloneJupytext(): Promise<string[]> {
  try {
    const output = await runCommand(["jupytext", "--version"])
    if (output && output.trim().length > 0) {
      return ["jupytext"]
    }
  } catch {
    // Standalone jupytext not in PATH
  }
  return []
}

function getSystemPythonPaths(): string[] {
  return process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"]
}

export async function getPythonPaths(resourceUri?: vscode.Uri): Promise<string[]> {
  const pythonConfigPath = config("python").get<string>("defaultInterpreterPath")

  // Priority 1: Active workspace environments from extensions
  const activeWorkspaceNewEnvs = await getActiveWorkspaceEnvsViaNewPythonEnvs(resourceUri)
  const activeWorkspaceMsPython = await getActiveEnvViaMsPython(resourceUri)

  // Priority 2: Direct workspace virtualenvs (.venv, venv, etc.)
  const workspaceVenvs = findWorkspaceVirtualenvs(resourceUri)

  // Priority 3: Standalone Jupytext CLI on PATH (uv tool, pipx, brew)
  const standaloneCli = await findStandaloneJupytext()

  // Priority 4: Other discovered extension environments (global active, all discovered)
  const otherNewEnvs = await getGlobalAndOtherEnvsViaNewPythonEnvs()
  const otherMsPythonEnvs = await getOtherEnvsViaMsPython()

  // Priority 5: System PATH python & settings fallback
  const systemPaths = getSystemPythonPaths()

  const orderedCandidates = [
    ...activeWorkspaceNewEnvs,
    ...activeWorkspaceMsPython,
    ...workspaceVenvs,
    ...standaloneCli,
    ...otherNewEnvs,
    ...otherMsPythonEnvs,
    ...systemPaths,
    ...(pythonConfigPath ? [pythonConfigPath] : []),
  ]

  const uniquePaths = Array.from(new Set(orderedCandidates))
  console.debug("Resolved candidate python / jupytext paths (ordered):", uniquePaths)
  return uniquePaths
}

export async function subscribeToPythonEnvChanges(
  context: vscode.ExtensionContext,
  onEnvChanged: (reason: string) => void,
): Promise<void> {
  const DEBOUNCE_MS = 500
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  const scheduleRevalidate = (reason: string) => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      onEnvChanged(reason)
    }, DEBOUNCE_MS)
  }

  // 1. Subscribe to ms-python.vscode-python-envs
  try {
    const newEnvsApi = await getNewPythonEnvsApi()
    if (newEnvsApi) {
      context.subscriptions.push(
        newEnvsApi.onDidChangeEnvironment(() =>
          scheduleRevalidate("Python environment changed (ms-python.vscode-python-envs)"),
        ),
        newEnvsApi.onDidChangeEnvironments(() =>
          scheduleRevalidate("Python environments list changed (ms-python.vscode-python-envs)"),
        ),
      )
    }
  } catch (ex) {
    getJConsole().appendLine(`Failed to subscribe to ms-python.vscode-python-envs changes: ${ex}`)
  }

  // 2. Subscribe to ms-python.python
  try {
    const pythonExt = vscode.extensions.getExtension<PythonExtension>("ms-python.python")
    if (pythonExt) {
      const pythonApi = pythonExt.isActive ? pythonExt.exports : await pythonExt.activate()
      if (pythonApi?.environments?.onDidChangeActiveEnvironmentPath) {
        context.subscriptions.push(
          pythonApi.environments.onDidChangeActiveEnvironmentPath(() =>
            scheduleRevalidate("Python active environment changed (ms-python.python)"),
          ),
        )
      }
    }
  } catch (ex) {
    getJConsole().appendLine(`Failed to subscribe to ms-python.python changes: ${ex}`)
  }
}
