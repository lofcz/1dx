import { existsSync, readFileSync } from "fs";
import { basename, dirname, join } from "path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import {
  supabaseStartRetryUnix,
  supabaseStartRetryWindows,
  withPortEnvUnix,
  withPortEnvWindows,
} from "./shell-command.ts";

const VariableValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const VariablesSchema = z.record(z.string(), VariableValueSchema);
const VARIABLE_REF_PATTERN = /\$\{([a-zA-Z0-9_.-]+)\}/g;

const HealthSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("port"),
    port: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("process"),
    name: z.string().min(1),
  }),
  z.object({
    type: z.literal("ambient"),
    check: z.enum(["docker"]),
  }),
]);

const StartSchema = z.object({
  shellCommand: z.string().min(1),
  // Bash/zsh form. On Unix, 1dx prefers this over translating `shellCommand`.
  unixShellCommand: z.string().min(1).optional(),
  manualCommand: z.string().optional(),
});

const CleanupSchema = z.object({
  ports: z.array(z.number().int().positive()).optional(),
  processNames: z.array(z.string()).optional(),
  commandLineContains: z.array(z.string()).optional(),
});

const ServiceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  color: z.string().optional().default("white"),
  ambient: z.boolean().optional().default(false),
  health: HealthSchema.optional(),
  start: StartSchema.optional(),
  startPolicy: z.enum(["if-dead", "always-on-startup"]).optional().default("if-dead"),
  // What to do when the service's health port is already in use at startup.
  // omitted / "ignore" (default): treat the port as an already-running instance
  // and skip. "kill": free the port (kill whatever holds it) and start a fresh
  // instance -- useful when a stale dev server or another project squats on the
  // same port.
  onPortInUse: z.enum(["ignore", "kill"]).optional(),
  cleanup: CleanupSchema.optional(),
  // Close the spawned terminal tab/window once the start command exits.
  // Use for one-shot bootstraps (e.g. `supabase start`) that detach from the shell.
  closeTerminalOnFinish: z.boolean().optional(),
});

const ActionCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  label: z.string().min(1),
});

const RecoverySchema = z.object({
  kind: z.literal("supabaseMigrationOrderingGuard"),
  retry: ActionCommandSchema,
});

const ActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  shortcut: z.string().min(1),
  mode: z.enum(["inline", "external", "internal"]),
  builtIn: z.enum(["start-dead", "stop-services", "refresh", "open-frontend", "open-url", "new-terminal", "kill-port", "exit"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  // For builtIn: "kill-port" -- which port(s) to free. Provide an explicit
  // `port`, target a service's health port via `serviceId`, or omit both to
  // free every managed service's configured port(s).
  port: z.number().int().positive().optional(),
  serviceId: z.string().optional(),
  onSuccess: ActionCommandSchema.optional(),
  recovery: RecoverySchema.optional(),
});

const ProjectSchema = z.object({
  name: z.string().optional(),
  packageManager: z.enum(["bun"]).optional().default("bun"),
  frontendUrl: z.string().optional(),
  dependencyInstallCommand: z.array(z.string()).optional().default(["bun", "install"]),
});

const StartupSchema = z.object({
  autoInstallDependencies: z.boolean().optional().default(true),
  autoOpenFrontend: z.boolean().optional().default(true),
  frontendServiceId: z.string().optional().default("frontend"),
});

export const OneDxConfigSchema = z.object({
  variables: VariablesSchema.optional(),
  project: ProjectSchema,
  startup: StartupSchema.optional().default({
    autoInstallDependencies: true,
    autoOpenFrontend: true,
    frontendServiceId: "frontend",
  }),
  services: z.array(ServiceSchema),
  actions: z.array(ActionSchema),
});

export type OneDxConfig = z.infer<typeof OneDxConfigSchema>;
export type OneDxService = z.infer<typeof ServiceSchema>;
export type OneDxAction = z.infer<typeof ActionSchema>;
type OneDxVariableValue = z.infer<typeof VariableValueSchema>;

function variableRef(name: string) {
  return `\${${name}}`;
}

function resolveTemplateString(template: string, lookup: (name: string) => OneDxVariableValue) {
  const exactMatch = template.match(/^\$\{([a-zA-Z0-9_.-]+)\}$/);
  if (exactMatch) {
    return lookup(exactMatch[1]);
  }

  return template.replace(VARIABLE_REF_PATTERN, (_, name: string) => String(lookup(name)));
}

function resolveTemplateValue(value: unknown, lookup: (name: string) => OneDxVariableValue): unknown {
  if (typeof value === "string") {
    return resolveTemplateString(value, lookup);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, lookup));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, resolveTemplateValue(entryValue, lookup)]),
    );
  }

  return value;
}

function resolveConfigVariables(rawConfig: unknown) {
  const rawObject = rawConfig && typeof rawConfig === "object" ? rawConfig as Record<string, unknown> : {};
  const rawVariables = rawObject.variables && typeof rawObject.variables === "object"
    ? rawObject.variables as Record<string, unknown>
    : {};

  const resolvedVariables: Record<string, OneDxVariableValue> = {};
  const resolving = new Set<string>();

  const resolveVariable = (name: string): OneDxVariableValue => {
    if (name in resolvedVariables) {
      return resolvedVariables[name];
    }
    if (!(name in rawVariables)) {
      throw new Error(`Unknown 1dx variable: ${name}`);
    }
    if (resolving.has(name)) {
      throw new Error(`Circular 1dx variable reference: ${name}`);
    }

    resolving.add(name);
    const resolved = resolveTemplateValue(rawVariables[name], resolveVariable);
    const parsed = VariableValueSchema.parse(resolved);
    resolvedVariables[name] = parsed;
    resolving.delete(name);
    return parsed;
  };

  for (const name of Object.keys(rawVariables)) {
    resolveVariable(name);
  }

  return resolveTemplateValue(
    {
      ...rawObject,
      variables: Object.keys(resolvedVariables).length > 0 ? resolvedVariables : undefined,
    },
    resolveVariable,
  );
}

export function findProjectRoot(startDir = process.cwd()) {
  let current = startDir;

  while (true) {
    if (existsSync(join(current, "package.json"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function readPackageJson(projectRoot: string) {
  return JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
}

export function inferProjectName(projectRoot: string) {
  try {
    const pkg = readPackageJson(projectRoot);
    return pkg.name || basename(projectRoot);
  } catch {
    return basename(projectRoot);
  }
}

export function loadOneDxConfig(projectRoot: string) {
  const configPath = join(projectRoot, "1dx.json");
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  const resolved = resolveConfigVariables(raw);
  const parsed = OneDxConfigSchema.parse(resolved);

  return {
    path: configPath,
    config: {
      ...parsed,
      project: {
        ...parsed.project,
        name: parsed.project.name || inferProjectName(projectRoot),
      },
    },
  };
}

export function isOneDxInstalled(projectRoot: string) {
  const pkg = readPackageJson(projectRoot);
  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  return Boolean(allDeps["1dxway"]);
}

export function detectVitePort(projectRoot: string) {
  try {
    const content = readFileSync(join(projectRoot, "vite.config.ts"), "utf8");
    const match = content.match(/port:\s*(\d+)/);
    return match?.[1] ? Number.parseInt(match[1], 10) : 8080;
  } catch {
    return 8080;
  }
}

export function detectSupabasePorts(projectRoot: string) {
  try {
    const content = readFileSync(join(projectRoot, "supabase", "config.toml"), "utf8");
    const config = parseToml(content) as any;
    return {
      apiPort: config.api?.port || 54321,
      studioPort: config.studio?.port || 54323,
    };
  } catch {
    return {
      apiPort: 54321,
      studioPort: 54323,
    };
  }
}

export function detectSciobotPreset(projectRoot: string): OneDxConfig {
  const pkg = readPackageJson(projectRoot);
  const vitePort = detectVitePort(projectRoot);
  const { apiPort, studioPort } = detectSupabasePorts(projectRoot);
  const hasI18n = Boolean(pkg.scripts?.i18n);
  const hasSupabase = existsSync(join(projectRoot, "supabase", "config.toml"));
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has1tube = Boolean(allDeps["1tube"]);
  const frontendPortRef = variableRef("frontendPort");
  const supabaseApiPortRef = variableRef("supabaseApiPort");
  const supabaseStudioPortRef = variableRef("supabaseStudioPort");
  const edgePortRef = variableRef("edgePort");
  const variables: Record<string, string | number | boolean> = {
    frontendPort: vitePort,
    supabaseApiPort: apiPort,
    supabaseStudioPort: studioPort,
  };

  if (has1tube) {
    variables.edgePort = 3100;
  }

  const frontendUrl = `http://localhost:${frontendPortRef}`;

  const backendShellSuffix = has1tube
    ? "echo Supabase started. This terminal can be closed."
    : "bun run supabase:functions:serve";
  const backendManualCommand = has1tube
    ? "echo Supabase is already running."
    : "bun run supabase:functions:serve";
  const backendCleanup = has1tube
    ? ["supabase start"]
    : ["supabase functions serve", "supabase:functions:serve"];

  const services: OneDxService[] = [
    {
      id: "docker",
      title: "Docker Engine",
      color: "white",
      ambient: true,
      startPolicy: "if-dead",
      health: { type: "ambient", check: "docker" },
    },
    {
      id: "backend",
      title: "Backend (Supabase)",
      color: "magenta",
      ambient: false,
      health: { type: "port", port: supabaseApiPortRef as any },
      start: {
        shellCommand: supabaseStartRetryWindows(backendShellSuffix),
        unixShellCommand: supabaseStartRetryUnix(backendShellSuffix),
        manualCommand: backendManualCommand,
      },
      startPolicy: "always-on-startup",
      cleanup: {
        commandLineContains: backendCleanup,
      },
      closeTerminalOnFinish: true,
    },
  ];

  if (has1tube) {
    services.push({
      id: "edge",
      title: "Edge Functions (1tube)",
      color: "cyan",
      ambient: false,
      health: { type: "port", port: edgePortRef as any },
      start: {
        shellCommand: withPortEnvWindows(edgePortRef, "bun run edge:serve"),
        unixShellCommand: withPortEnvUnix(edgePortRef, "bun run edge:serve"),
      },
      startPolicy: "if-dead",
      cleanup: {
        ports: [edgePortRef as any],
        commandLineContains: ["edge:serve", "1tube/src/server.ts"],
      },
    });
  }

  services.push({
    id: "frontend",
    title: "Frontend (Vite)",
    color: "green",
    ambient: false,
    health: { type: "port", port: frontendPortRef as any },
    start: {
      shellCommand: "bun run dev",
    },
    startPolicy: "if-dead",
    cleanup: {
      ports: [frontendPortRef as any],
      commandLineContains: ["vite", "bun run dev"],
    },
  });

  if (hasI18n) {
    services.push({
      id: "i18n",
      title: "i18n (typesafe-i18n)",
      color: "blue",
      ambient: false,
      health: { type: "process", name: "typesafe-i18n" },
      start: {
        shellCommand: "bun run i18n",
      },
      startPolicy: "if-dead",
      cleanup: {
        processNames: ["typesafe-i18n"],
        commandLineContains: ["typesafe-i18n", "bun run i18n"],
      },
    });
  }

  const actions: OneDxAction[] = [
    {
      id: "up",
      label: "Run migrations (up)",
      shortcut: "1",
      mode: "inline",
      command: "bun",
      args: ["run", "supabase:up"],
      onSuccess: {
        command: "bun",
        args: ["run", "supabase:types"],
        label: "Regenerating types (supabase:types)...",
      },
      recovery: {
        kind: "supabaseMigrationOrderingGuard",
        retry: {
          command: "bun",
          args: ["run", "supabase:up:all"],
          label: "Run migrations (up --include-all)",
        },
      },
    },
    {
      id: "reset",
      label: "Reset DB",
      shortcut: "2",
      mode: "inline",
      command: "bun",
      args: ["run", "supabase:reset"],
    },
    {
      id: "start-dead",
      label: "Start dead services",
      shortcut: "3",
      mode: "internal",
      builtIn: "start-dead",
    },
    {
      id: "stop",
      label: "Stop all services",
      shortcut: "4",
      mode: "internal",
      builtIn: "stop-services",
    },
    ...(hasSupabase
      ? [
          {
            id: "studio",
            label: "Open Supabase Studio",
            shortcut: "5",
            mode: "internal",
            builtIn: "open-url",
            url: `http://127.0.0.1:${supabaseStudioPortRef}`,
          } satisfies OneDxAction,
        ]
      : []),
    {
      id: "refresh",
      label: "Refresh status",
      shortcut: "6",
      mode: "internal",
      builtIn: "refresh",
    },
    {
      id: "install-deps",
      label: "Install deps",
      shortcut: "7",
      mode: "inline",
      command: "bun",
      args: ["install"],
    },
    {
      id: "update-deps",
      label: "Update deps",
      shortcut: "8",
      mode: "inline",
      command: "bun",
      args: ["update"],
    },
    {
      id: "update-deps-interactive",
      label: "Update deps (interactive)",
      shortcut: "u",
      mode: "external",
      command: "bun",
      args: ["update", "-i"],
    },
    {
      id: "frontend",
      label: "Open frontend in browser",
      shortcut: "f",
      mode: "internal",
      builtIn: "open-frontend",
    },
    {
      id: "lint",
      label: "Run lint",
      shortcut: "l",
      mode: "external",
      command: "bun",
      args: ["run", "lint"],
    },
    {
      id: "exit",
      label: "Exit monitor",
      shortcut: "q",
      mode: "internal",
      builtIn: "exit",
    },
    {
      id: "react-doctor",
      label: "Run react-doctor",
      shortcut: "r",
      mode: "external",
      command: "bunx",
      args: ["-y", "react-doctor@latest", ".", "--verbose"],
    },
    {
      id: "terminal",
      label: "Open new terminal",
      shortcut: "t",
      mode: "internal",
      builtIn: "new-terminal",
    },
  ];

  return {
    variables,
    project: {
      name: inferProjectName(projectRoot),
      packageManager: "bun",
      frontendUrl,
      dependencyInstallCommand: ["bun", "install"],
    },
    startup: {
      autoInstallDependencies: true,
      autoOpenFrontend: true,
      frontendServiceId: "frontend",
    },
    services,
    actions,
  };
}

export function detectGenericPreset(projectRoot: string): OneDxConfig {
  const pkg = readPackageJson(projectRoot);
  const vitePort = detectVitePort(projectRoot);
  const hasVite = Boolean(pkg.scripts?.dev) || existsSync(join(projectRoot, "vite.config.ts"));
  const frontendPortRef = variableRef("frontendPort");
  const frontendUrl = hasVite ? `http://localhost:${frontendPortRef}` : undefined;

  const services: OneDxService[] = [];
  if (hasVite) {
    services.push({
      id: "frontend",
      title: "Frontend",
      color: "green",
      ambient: false,
      health: { type: "port", port: frontendPortRef as any },
      start: {
        shellCommand: "bun run dev",
      },
      startPolicy: "if-dead",
      cleanup: {
        ports: [frontendPortRef as any],
        commandLineContains: ["vite", "bun run dev"],
      },
    });
  }

  return {
    variables: hasVite ? { frontendPort: vitePort } : undefined,
    project: {
      name: inferProjectName(projectRoot),
      packageManager: "bun",
      frontendUrl,
      dependencyInstallCommand: ["bun", "install"],
    },
    startup: {
      autoInstallDependencies: true,
      autoOpenFrontend: Boolean(frontendUrl),
      frontendServiceId: "frontend",
    },
    services,
    actions: [
      ...(hasVite
        ? [
            {
              id: "start-dead",
              label: "Start dead services",
              shortcut: "1",
              mode: "internal",
              builtIn: "start-dead",
            } satisfies OneDxAction,
            {
              id: "stop",
              label: "Stop all services",
              shortcut: "2",
              mode: "internal",
              builtIn: "stop-services",
            } satisfies OneDxAction,
            {
              id: "install-deps",
              label: "Install deps",
              shortcut: "3",
              mode: "inline",
              command: "bun",
              args: ["install"],
            } satisfies OneDxAction,
            {
              id: "update-deps",
              label: "Update deps",
              shortcut: "4",
              mode: "inline",
              command: "bun",
              args: ["update"],
            } satisfies OneDxAction,
            {
              id: "update-deps-interactive",
              label: "Update deps (interactive)",
              shortcut: "u",
              mode: "external",
              command: "bun",
              args: ["update", "-i"],
            } satisfies OneDxAction,
            {
              id: "frontend",
              label: "Open frontend in browser",
              shortcut: "f",
              mode: "internal",
              builtIn: "open-frontend",
            } satisfies OneDxAction,
            {
              id: "lint",
              label: "Run lint",
              shortcut: "l",
              mode: "external",
              command: "bun",
              args: ["run", "lint"],
            } satisfies OneDxAction,
          ]
        : []),
      {
        id: "refresh",
        label: "Refresh status",
        shortcut: hasVite ? "5" : "1",
        mode: "internal",
        builtIn: "refresh",
      },
      {
        id: "terminal",
        label: "Open new terminal",
        shortcut: "t",
        mode: "internal",
        builtIn: "new-terminal",
      },
      {
        id: "exit",
        label: "Exit monitor",
        shortcut: "q",
        mode: "internal",
        builtIn: "exit",
      },
    ],
  };
}
