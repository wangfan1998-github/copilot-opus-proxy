# copilot-opus-proxy

一个本地代理，把 GitHub Copilot 的 Claude 接口暴露成兼容 Anthropic Messages API 的端点。

- GitHub Device Flow 登录
- 多账号加载与轮换
- 429 限流自动跳过并冷却
- 401 自动刷新 Copilot token
- 兼容 `POST /v1/messages`
- 提供 `GET /v1/models` 和 `GET /healthz`
- 支持流式和非流式响应

## 运行要求

- Node.js 22+

## 快速开始

```bash
git clone https://github.com/wangfan1998-github/copilot-opus-proxy
cd copilot-opus-proxy
node src/index.js login
node src/index.js
```

默认监听 `http://127.0.0.1:4123`，也可以改端口：

```bash
PORT=8080 node src/index.js
```

## 命令

```bash
node src/index.js login
node src/index.js list
node src/index.js
```

## 账号来源

启动时按这个顺序找 GitHub token：

1. `~/.config/copilot-opus-proxy/credentials.json`
2. 环境变量 `GH_TOKEN` / `GITHUB_TOKEN`
3. `~/.config/github-copilot/hosts.json`
4. `~/.config/github-copilot/apps.json`

如果本地没有可用账号，程序会自动进入首次登录。

## Claude Code 配置示例

在 `.claude/settings.json` 里把请求指向本地代理：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4123",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "claude-opus-4.6",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-sonnet-4.6",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "ENABLE_TOOL_SEARCH": "0"
  }
}
```

`ANTHROPIC_AUTH_TOKEN` 这里只是占位值，代理真正使用的是 GitHub Copilot token。

## 可用接口

- `POST /v1/messages`
- `GET /v1/models`
- `GET /healthz`

## 支持模型

- `claude-opus-4.6`
- `claude-opus-4.5`
- `claude-sonnet-4.6`
- `claude-sonnet-4.5`
- `claude-sonnet-4`
- `claude-haiku-4.5`

## 说明

项目默认使用 Node.js 22 的原生 `fetch`、流式响应和本地文件存储，不依赖额外服务，适合直接本地运行和接入 Claude Code。
