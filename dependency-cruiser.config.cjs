/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Runtime circular dependencies make event and projection ordering harder to reason about.",
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: "domain-is-independent",
      severity: "error",
      from: {
        path: "^src/domain",
      },
      to: {
        path: "^(app|components|db|src/(application|ports|infrastructure|presentation))",
      },
    },
    {
      name: "application-does-not-import-delivery-or-infrastructure",
      severity: "error",
      from: {
        path: "^src/application",
      },
      to: {
        path: "^(app|components|db|src/(infrastructure|presentation))",
      },
    },
    {
      name: "ports-do-not-import-implementations",
      severity: "error",
      from: {
        path: "^src/ports",
      },
      to: {
        path: "^(app|components|db|src/(application|infrastructure|presentation))",
      },
    },
    {
      name: "presentation-does-not-import-delivery-or-infrastructure",
      severity: "error",
      from: {
        path: "^src/presentation",
      },
      to: {
        path: "^(app|components|db|src/(application|ports|infrastructure))",
      },
    },
    {
      name: "components-do-not-import-application-or-infrastructure",
      severity: "error",
      from: {
        path: "^components",
      },
      to: {
        path: "^(app|db|src/(application|ports|infrastructure))",
      },
    },
    {
      name: "infrastructure-does-not-import-delivery",
      severity: "error",
      from: {
        path: "^src/infrastructure",
      },
      to: {
        path: "^(app|components)",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    exclude: {
      path: "^(node_modules|\\.next|frontend|coverage|dist|out|\\.pnpm-store)",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
  },
};
