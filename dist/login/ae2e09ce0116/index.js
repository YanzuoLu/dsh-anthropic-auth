// lib/provider-login.js
import { randomUUID } from "node:crypto";
import { credentialKey } from "@deepseek-ai/dsh-credentials";
var LOGIN_TIMEOUT_MS = 15 * 60 * 1e3;
var MAX_INPUT_LENGTH = 8192;
var MESSAGES = {
  NO_FLOW: "\u539F\u751F OAuth \u767B\u5F55\u5C1A\u672A\u5C31\u7EEA\uFF0C\u8BF7\u786E\u8BA4\u5BF9\u5E94\u6A21\u578B\u63D0\u4F9B\u65B9\u5DF2\u542F\u7528\u3002",
  ALREADY_IN_FLIGHT: "\u6B64\u63D0\u4F9B\u65B9\u6B63\u5728\u5176\u4ED6\u9875\u9762\u767B\u5F55\uFF0C\u8BF7\u5148\u5B8C\u6210\u6216\u53D6\u6D88\u539F\u6765\u7684\u767B\u5F55\u3002",
  NO_PROMPT: "\u8FD9\u4E2A\u767B\u5F55\u95EE\u9898\u5DF2\u7ED3\u675F\uFF0C\u8BF7\u4F7F\u7528\u5F53\u524D\u9875\u9762\u4E2D\u7684\u6700\u65B0\u95EE\u9898\u3002",
  INVALID_ANSWER: "\u8F93\u5165\u5185\u5BB9\u65E0\u6548\uFF0C\u8BF7\u68C0\u67E5\u540E\u91CD\u8BD5\u3002",
  LOGIN_FAILED: "\u767B\u5F55\u672A\u5B8C\u6210\uFF0C\u8BF7\u68C0\u67E5\u5F53\u524D\u51ED\u636E\u72B6\u6001\u540E\u91CD\u8BD5\u3002",
  LOGIN_TIMEOUT: "\u767B\u5F55\u7B49\u5F85\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0\u5F00\u59CB\u3002",
  DISPOSED: "\u767B\u5F55\u754C\u9762\u5DF2\u505C\u6B62\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u3002",
  OPERATION_FAILED: "\u8BA4\u8BC1\u64CD\u4F5C\u672A\u5B8C\u6210\uFF0C\u8BF7\u91CD\u8BD5\u3002"
};
var ProviderLoginError = class extends Error {
  constructor(code) {
    super(MESSAGES[code] ?? MESSAGES.OPERATION_FAILED);
    this.name = "ProviderLoginError";
    this.code = code in MESSAGES ? code : "OPERATION_FAILED";
  }
};
function withdrawn() {
  return new DOMException("Authorization prompt withdrawn", "AbortError");
}
function publicPrompt(request) {
  if (!["text", "secret", "select"].includes(request.kind) || typeof request.message !== "string") {
    throw new TypeError("Unsupported native authorization prompt");
  }
  const view = { id: randomUUID(), kind: request.kind, message: request.message.slice(0, 2048) };
  if (request.kind === "select") {
    if (!Array.isArray(request.options) || request.options.length > 100 || request.options.some((option) => typeof option.id !== "string" || !option.id || option.id.length > 256 || typeof option.label !== "string")) {
      throw new TypeError("Invalid native authorization choices");
    }
    view.options = request.options.map((option) => ({
      id: option.id,
      label: option.label.slice(0, 512),
      ...typeof option.description === "string" ? { description: option.description.slice(0, 1024) } : {}
    }));
  } else if (typeof request.placeholder === "string") view.placeholder = request.placeholder.slice(0, 1024);
  return view;
}
function createProviderLogin(ctx, { provider, label, allowedAuthHosts }) {
  const key = credentialKey("llm-pi-ai", provider);
  const hosts = new Set(allowedAuthHosts.map((host) => host.toLowerCase()));
  let flow;
  let generation = 0;
  let disposed = false;
  let logoutTask;
  const tasks = /* @__PURE__ */ new Set();
  function current(candidate) {
    return !disposed && flow === candidate && candidate.generation === generation;
  }
  function accepting(candidate) {
    return current(candidate) && candidate.status === "pending" && !candidate.controller.signal.aborted;
  }
  function withdrawPrompt(candidate) {
    const pending = candidate?.prompt;
    if (!pending) return;
    candidate.prompt = void 0;
    pending.cleanup();
    pending.reject(withdrawn());
  }
  function stop(candidate) {
    if (!candidate || candidate.status !== "pending") return;
    candidate.controller.abort(withdrawn());
    withdrawPrompt(candidate);
    candidate.ready.resolve();
  }
  function authUrl(raw) {
    if (typeof raw !== "string" || raw.length > MAX_INPUT_LENGTH) return void 0;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return void 0;
    }
    return url.protocol === "https:" && !url.username && !url.password && hosts.has(url.hostname.toLowerCase()) ? url.href : void 0;
  }
  async function status() {
    const entry = ctx.authorization.describe(key);
    const record = await ctx.credentials.readRecord(key);
    const oauth = record?.kind === "grant" && record.payload?.type === "oauth";
    const expires = oauth && typeof record.payload.expires === "number" && Number.isFinite(record.payload.expires) ? record.payload.expires : void 0;
    const pending = flow?.status === "pending";
    return {
      authenticated: Boolean(record),
      ...record ? { credentialKind: oauth ? "oauth" : record.kind } : {},
      ...expires === void 0 ? {} : { expires, expired: expires <= Date.now() },
      available: Boolean(entry?.methods.some((method) => method.id === "oauth")),
      inFlight: Boolean(entry?.inFlight),
      login: {
        status: flow?.status ?? "idle",
        ...pending && flow.authUrl ? { authUrl: flow.authUrl } : {},
        ...pending && flow.notice ? { notice: flow.notice } : {},
        ...pending && flow.deviceCode ? { deviceCode: flow.deviceCode } : {},
        ...pending && flow.prompt ? { prompt: flow.prompt.view } : {},
        ...flow?.status === "error" ? { error: MESSAGES[flow.errorCode] ?? MESSAGES.LOGIN_FAILED } : {}
      }
    };
  }
  async function startLogin() {
    if (disposed) throw new ProviderLoginError("DISPOSED");
    if (logoutTask) throw new ProviderLoginError("ALREADY_IN_FLIGHT");
    if (flow?.status === "pending") {
      await flow.ready.promise;
      return status();
    }
    const entry = ctx.authorization.describe(key);
    if (!entry?.methods.some((method) => method.id === "oauth")) throw new ProviderLoginError("NO_FLOW");
    if (entry.inFlight) throw new ProviderLoginError("ALREADY_IN_FLIGHT");
    const candidate = {
      generation: ++generation,
      controller: new AbortController(),
      ready: Promise.withResolvers(),
      status: "pending"
    };
    flow = candidate;
    const timeout = setTimeout(() => {
      candidate.timedOut = true;
      stop(candidate);
    }, LOGIN_TIMEOUT_MS);
    timeout.unref?.();
    candidate.task = (async () => {
      try {
        const outcome = await ctx.authorization.begin({
          key,
          method: "oauth",
          signal: candidate.controller.signal,
          interaction: {
            notify(notice) {
              if (!accepting(candidate)) return;
              if (typeof notice.message === "string") candidate.notice = notice.message.slice(0, 2048);
              const url = authUrl(notice.url);
              if (url) candidate.authUrl = url;
              if (typeof notice.code === "string") candidate.deviceCode = notice.code.slice(0, 256);
              candidate.ready.resolve();
            },
            prompt(request) {
              if (!accepting(candidate) || request.signal?.aborted) return Promise.reject(withdrawn());
              withdrawPrompt(candidate);
              const view = publicPrompt(request);
              const result = Promise.withResolvers();
              const pending = {
                view,
                resolve: result.resolve,
                reject: result.reject,
                cleanup() {
                  request.signal?.removeEventListener("abort", abort);
                }
              };
              const abort = () => {
                if (candidate.prompt === pending) candidate.prompt = void 0;
                pending.cleanup();
                result.reject(withdrawn());
              };
              candidate.prompt = pending;
              request.signal?.addEventListener("abort", abort, { once: true });
              candidate.ready.resolve();
              return result.promise;
            }
          }
        });
        if (current(candidate)) candidate.status = outcome.status === "authorized" ? "complete" : candidate.timedOut ? "error" : "cancelled";
        if (candidate.timedOut) candidate.errorCode = "LOGIN_TIMEOUT";
      } catch (error) {
        if (current(candidate)) {
          candidate.status = candidate.controller.signal.aborted && !candidate.timedOut ? "cancelled" : "error";
          candidate.errorCode = candidate.timedOut ? "LOGIN_TIMEOUT" : error?.code === "NO_FLOW" || error?.code === "UNKNOWN_METHOD" ? "NO_FLOW" : error?.code === "ALREADY_IN_FLIGHT" ? "ALREADY_IN_FLIGHT" : "LOGIN_FAILED";
        }
      } finally {
        clearTimeout(timeout);
        withdrawPrompt(candidate);
        candidate.authUrl = void 0;
        candidate.notice = void 0;
        candidate.deviceCode = void 0;
        candidate.ready.resolve();
      }
    })();
    tasks.add(candidate.task);
    candidate.task.finally(() => tasks.delete(candidate.task)).catch(() => {
    });
    await candidate.ready.promise;
    return status();
  }
  return {
    status,
    startLogin,
    async answer({ promptId, input }) {
      const candidate = flow;
      const pending = candidate?.prompt;
      if (!candidate || !accepting(candidate) || !pending || pending.view.id !== promptId) {
        throw new ProviderLoginError("NO_PROMPT");
      }
      if (typeof input !== "string" || !input.trim() || input.length > MAX_INPUT_LENGTH || pending.view.kind === "select" && !pending.view.options.some((option) => option.id === input)) {
        throw new ProviderLoginError("INVALID_ANSWER");
      }
      candidate.prompt = void 0;
      pending.cleanup();
      pending.resolve(input);
      return status();
    },
    async cancelLogin() {
      const candidate = flow;
      stop(candidate);
      if (candidate?.task) await candidate.task;
      return status();
    },
    logout() {
      if (logoutTask) return logoutTask;
      const candidate = flow;
      if (ctx.authorization.describe(key)?.inFlight && candidate?.status !== "pending") {
        return Promise.reject(new ProviderLoginError("ALREADY_IN_FLIGHT"));
      }
      const operation = (async () => {
        stop(candidate);
        if (candidate?.task) await candidate.task;
        if (ctx.authorization.describe(key)?.inFlight) throw new ProviderLoginError("ALREADY_IN_FLIGHT");
        await ctx.credentials.deleteRecord(key);
        if (flow === candidate) flow = void 0;
        return status();
      })();
      logoutTask = operation;
      operation.finally(() => {
        if (logoutTask === operation) logoutTask = void 0;
      }).catch(() => {
      });
      return operation;
    },
    async dispose() {
      disposed = true;
      generation++;
      stop(flow);
      await Promise.allSettled([...tasks, ...logoutTask ? [logoutTask] : []]);
    }
  };
}

// lib/provider-login-routes.js
function json(status, body) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}
function failure(status, code, message) {
  return json(status, { ok: false, error: { code, message } });
}
function mountProviderLoginRoutes(ctx, controller, { apiPath }) {
  if (!/^\/api\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(apiPath)) throw new TypeError("Invalid login API path");
  const actions = {
    status: () => controller.status(),
    "start-login": () => controller.startLogin(),
    answer: (body) => controller.answer(body),
    "cancel-login": () => controller.cancelLogin(),
    logout: () => controller.logout()
  };
  const disposers = Object.entries(actions).map(([action, execute]) => ctx.connection.fetch.register({
    path: `${apiPath}/${action}`,
    methods: ["POST"],
    requestBody: "buffered",
    async fetch(request) {
      const admission = ctx.connection.admit(request);
      if ("rejection" in admission) return failure(admission.rejection, "UNAUTHORIZED", "\u8BF7\u5148\u767B\u5F55 DSH\u3002");
      if (request.method !== "POST") return failure(405, "METHOD_NOT_ALLOWED", "\u53EA\u63A5\u53D7 POST \u8BF7\u6C42\u3002");
      if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        return failure(415, "INVALID_CONTENT_TYPE", "\u8BF7\u6C42\u5FC5\u987B\u4F7F\u7528 application/json\u3002");
      }
      let body;
      try {
        const text = await request.text();
        if (text.length > 65536) return failure(413, "INVALID_REQUEST", "\u8BF7\u6C42\u5185\u5BB9\u8FC7\u957F\u3002");
        body = JSON.parse(text);
      } catch {
        return failure(400, "INVALID_REQUEST", "\u8BF7\u6C42\u5FC5\u987B\u5305\u542B JSON \u5BF9\u8C61\u3002");
      }
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => action !== "answer" || !["promptId", "input"].includes(key)) || action === "answer" && (typeof body.promptId !== "string" || !body.promptId || body.promptId.length > 64 || typeof body.input !== "string" || !body.input.trim() || body.input.length > 8192)) {
        return failure(400, "INVALID_REQUEST", "\u8BF7\u6C42\u53C2\u6570\u65E0\u6548\u3002");
      }
      try {
        return json(200, { ok: true, value: await execute(body) });
      } catch (error) {
        if (error instanceof ProviderLoginError) {
          const status = error.code === "NO_FLOW" ? 503 : error.code === "ALREADY_IN_FLIGHT" || error.code === "NO_PROMPT" ? 409 : error.code === "INVALID_ANSWER" ? 400 : error.code === "DISPOSED" ? 410 : 500;
          return failure(status, error.code, error.message);
        }
        return failure(500, "OPERATION_FAILED", "\u8BA4\u8BC1\u64CD\u4F5C\u672A\u5B8C\u6210\uFF0C\u8BF7\u91CD\u8BD5\u3002");
      }
    }
  }));
  return async () => {
    await Promise.all(disposers.map((dispose) => dispose()));
  };
}

// login-entry.js
var name = "anthropic-login";
var inject = ["authorization", "credentials"];
function apply(ctx) {
  const controller = createProviderLogin(ctx, {
    provider: "anthropic",
    label: "Anthropic",
    allowedAuthHosts: ["claude.ai", "console.anthropic.com", "platform.claude.com"]
  });
  ctx.effect(() => () => controller.dispose(), "anthropic login controller");
  ctx.inject(["connection"], (child) => child.effect(
    () => mountProviderLoginRoutes(child, controller, { apiPath: "/api/dsh-anthropic-auth" }),
    "anthropic login routes"
  ));
}
export {
  apply,
  inject,
  name
};
