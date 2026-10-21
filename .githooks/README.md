# .githooks —— 推送前门禁

本目录由 `core.hooksPath` 指向（`git config core.hooksPath .githooks`）。

| 钩子 | 作用 |
|---|---|
| `pre-push` | 推送前在 WSL（Ubuntu）里执行与 CI 等价的检查：`npm run check` + `npm test`；不通过就中止推送 |

规矩：

- **不要用 `--no-verify` 绕过**。确需绕过，先跟主人说明理由并取得同意。
- WSL 不可用时，钩子回退到本机执行同一组检查（仍是一道门禁）。
- 换机器克隆后需要重新启用一次：

```bash
git config core.hooksPath .githooks
```
