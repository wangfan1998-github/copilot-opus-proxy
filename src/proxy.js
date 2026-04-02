import { createServer } from "node:http";
import { Readable } from "node:stream";
import {
  ensureValidToken,
  getCopilotBaseUrl,
  getCopilotHeaders,
  refreshAccount,
  SUPPORTED_MODELS,
} from "./auth.js";

function createCorsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    ...extra,
  };
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function describeMessage(message) {
  if (!message) {
    return "empty";
  }

  if (message.role === "user") {
    if (Array.isArray(message.content)) {
      const types = message.content.map((block) => block.type);
      if (types.includes("tool_result")) {
        const count = message.content.filter((block) => block.type === "tool_result").length;
        return `tool_result(${count})`;
      }

      const firstText = message.content.find((block) => typeof block.text === "string")?.text ?? "...";
      return `user: ${String(firstText).slice(0, 60)}`;
    }

    if (typeof message.content === "string") {
      return `user: ${message.content.slice(0, 60)}`;
    }
  }

  if (message.role === "assistant") {
    if (Array.isArray(message.content)) {
      const types = [...new Set(message.content.map((block) => block.type))];
      return `assistant[${types.join(",")}]`;
    }

    return "assistant";
  }

  return message.role ?? "unknown";
}

function inferInitiator(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastMessage = messages.at(-1);

  if (!lastMessage || lastMessage.role !== "user") {
    return "agent";
  }

  if (
    Array.isArray(lastMessage.content) &&
    lastMessage.content.some((block) => block.type === "tool_result")
  ) {
    return "agent";
  }

  return "user";
}

function hasImageContent(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];

  return messages.some((message) => {
    if (!Array.isArray(message.content)) {
      return false;
    }

    return message.content.some((block) => {
      if (block.type === "image") {
        return true;
      }

      return (
        block.type === "tool_result" &&
        Array.isArray(block.content) &&
        block.content.some((item) => item.type === "image")
      );
    });
  });
}

function parseCooldownMs(response) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }

  const rateLimitReset = response.headers.get("x-ratelimit-reset");
  if (rateLimitReset) {
    const resetMs = Number.parseInt(rateLimitReset, 10) * 1000;
    if (Number.isFinite(resetMs)) {
      const remaining = resetMs - Date.now();
      if (remaining > 0) {
        return remaining;
      }
    }
  }

  return 60 * 60 * 1000;
}

function logQuota(accountIndex, headers) {
  const snapshot = headers.get("x-quota-snapshot-premium_models")
    || headers.get("x-quota-snapshot-premium_interactions")
    || headers.get("x-quota-snapshot-chat");

  if (!snapshot) {
    return;
  }

  try {
    const params = new URLSearchParams(snapshot);
    const remaining = params.get("rem");
    const entitlement = params.get("ent");
    const overage = params.get("ov");

    console.log(`#${accountIndex + 1} quota: ${remaining}% remaining (ent=${entitlement}, overage=${overage})`);
  } catch {
    // ignore malformed quota headers
  }
}

async function extractStreamUsage(stream, model, accountIndex) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const usage = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          continue;
        }

        const raw = line.slice(6);
        if (raw === "[DONE]") {
          continue;
        }

        try {
          const event = JSON.parse(raw);
          if (event?.type === "message_start" && event?.message?.usage) {
            Object.assign(usage, event.message.usage);
          }
          if (event?.type === "message_delta" && event?.usage) {
            Object.assign(usage, event.usage);
          }
        } catch {
          // ignore non-json event lines
        }
      }
    }
  } catch {
    // client disconnected
  } finally {
    reader.releaseLock();
  }

  if (usage.input_tokens || usage.output_tokens) {
    const parts = [`#${accountIndex + 1} <- ${model}`];
    if (usage.input_tokens) {
      parts.push(`in=${usage.input_tokens}`);
    }
    if (usage.output_tokens) {
      parts.push(`out=${usage.output_tokens}`);
    }
    if (usage.cache_read_input_tokens) {
      parts.push(`cache_read=${usage.cache_read_input_tokens}`);
    }
    if (usage.cache_creation_input_tokens) {
      parts.push(`cache_write=${usage.cache_creation_input_tokens}`);
    }
    console.log(parts.join(" "));
  }
}

async function sendToUpstream(body, account, initiator, isStreaming, hasImages) {
  const headers = {
    "Content-Type": "application/json",
    Accept: isStreaming ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${account.copilotToken}`,
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
    "X-Initiator": initiator,
    "X-GitHub-Api-Version": "2025-05-01",
    "X-Request-Id": crypto.randomUUID(),
    "OpenAI-Intent": "conversation-agent",
    ...getCopilotHeaders(),
  };

  if (hasImages) {
    headers["Copilot-Vision-Request"] = "true";
  }

  return fetch(`${getCopilotBaseUrl(account)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function writeJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, createCorsHeaders({
    "Content-Type": "application/json",
    ...extraHeaders,
  }));
  res.end(JSON.stringify(payload));
}

export function startProxy(accounts, port) {
  let currentIndex = 0;
  const cooldowns = new Map();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, createCorsHeaders());
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      writeJson(res, 200, {
        data: SUPPORTED_MODELS.map((id) => ({
          id,
          display_name: id,
          type: "model",
          created_at: "2025-01-01T00:00:00Z",
        })),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      writeJson(res, 200, { ok: true, accounts: accounts.length });
      return;
    }

    if (!(req.method === "POST" && url.pathname === "/v1/messages")) {
      writeJson(res, 404, { error: "Not found" });
      return;
    }

    let body;
    try {
      body = await parseJsonBody(req);
    } catch (error) {
      writeJson(res, 400, { error: `Invalid JSON body: ${error.message}` });
      return;
    }

    const isStreaming = body.stream === true;
    const hasImages = hasImageContent(body);
    const initiator = inferInitiator(body);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const model = typeof body.model === "string" ? body.model : "unknown";
    const lastInfo = describeMessage(messages.at(-1));

    let attempts = 0;

    while (attempts < accounts.length) {
      const cooldownUntil = cooldowns.get(currentIndex);
      if (cooldownUntil && Date.now() < cooldownUntil) {
        const remainingMinutes = Math.ceil((cooldownUntil - Date.now()) / 60000);
        console.log(`#${currentIndex + 1} in cooldown (${remainingMinutes}m left), skipping`);
        currentIndex = (currentIndex + 1) % accounts.length;
        attempts += 1;
        continue;
      }

      try {
        accounts[currentIndex] = await ensureValidToken(accounts[currentIndex]);
      } catch (error) {
        console.error(`#${currentIndex + 1} token refresh failed: ${error.message}`);
        currentIndex = (currentIndex + 1) % accounts.length;
        attempts += 1;
        continue;
      }

      const account = accounts[currentIndex];
      console.log(`#${currentIndex + 1} -> ${model} [${initiator}] ${lastInfo}${isStreaming ? " (stream)" : ""}`);

      let upstreamResponse;
      try {
        upstreamResponse = await sendToUpstream(body, account, initiator, isStreaming, hasImages);
      } catch (error) {
        console.error(`#${currentIndex + 1} upstream request failed: ${error.message}`);
        currentIndex = (currentIndex + 1) % accounts.length;
        attempts += 1;
        continue;
      }

      if (upstreamResponse.status === 429) {
        const cooldownMs = parseCooldownMs(upstreamResponse);
        const errorText = await upstreamResponse.text();
        cooldowns.set(currentIndex, Date.now() + cooldownMs);
        console.error(`#${currentIndex + 1} !! 429 ${errorText.slice(0, 200)}`);
        console.error(`#${currentIndex + 1} cooldown: ${Math.ceil(cooldownMs / 60000)}m`);
        currentIndex = (currentIndex + 1) % accounts.length;
        attempts += 1;
        continue;
      }

      if (upstreamResponse.status === 401) {
        console.warn(`#${currentIndex + 1} !! 401, refreshing token...`);
        try {
          accounts[currentIndex] = await refreshAccount(account.githubToken);
          upstreamResponse = await sendToUpstream(
            body,
            accounts[currentIndex],
            initiator,
            isStreaming,
            hasImages,
          );
        } catch (error) {
          console.error(`#${currentIndex + 1} token refresh retry failed: ${error.message}`);
          currentIndex = (currentIndex + 1) % accounts.length;
          attempts += 1;
          continue;
        }
      }

      if (upstreamResponse.status >= 400) {
        const errorText = await upstreamResponse.text();

        if (upstreamResponse.status >= 500) {
          console.error(`#${currentIndex + 1} !! ${upstreamResponse.status} ${errorText.slice(0, 300)}`);
        }

        res.writeHead(upstreamResponse.status, createCorsHeaders({
          "Content-Type": upstreamResponse.headers.get("content-type") || "application/json",
        }));
        res.end(errorText);
        return;
      }

      logQuota(currentIndex, upstreamResponse.headers);

      if (isStreaming && upstreamResponse.body) {
        const [forwardStream, inspectStream] = upstreamResponse.body.tee();
        extractStreamUsage(inspectStream, model, currentIndex).catch(() => {});

        res.writeHead(200, createCorsHeaders({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        }));

        Readable.fromWeb(forwardStream).pipe(res);
        return;
      }

      const payload = await upstreamResponse.text();
      res.writeHead(200, createCorsHeaders({
        "Content-Type": upstreamResponse.headers.get("content-type") || "application/json",
      }));
      res.end(payload);
      return;
    }

    const nextRetryAt = [...cooldowns.values()].sort((a, b) => a - b)[0];
    const retryAfterSeconds = nextRetryAt ? Math.max(1, Math.ceil((nextRetryAt - Date.now()) / 1000)) : 60;

    writeJson(
      res,
      503,
      { error: "No Copilot accounts are currently available." },
      { "Retry-After": String(retryAfterSeconds) },
    );
  });

  server.listen(port);
  return server;
}
