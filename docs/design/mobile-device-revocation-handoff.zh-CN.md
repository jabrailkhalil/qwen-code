# 主监听器设备凭据撤销：范围交接

[English](mobile-device-revocation-handoff.md) | [简体中文](mobile-device-revocation-handoff.zh-CN.md)

## 状态与归属

本提案用于请维护者确认范围，不代表已实现 API，也不代表安全验收通过。源码审查基线为 2026 年 10 月 20 日的 `c8971faac9e2204f31bd06ffba94f8c92725f267`。

[#11704](https://github.com/QwenLM/qwen-code/issues/11704) 已接受 Android 外壳方向，但[维护者决定](https://github.com/QwenLM/qwen-code/issues/11704#issuecomment-5645279859)将主监听器可撤销凭据保留为 daemon 团队的工作。[后续状态](https://github.com/QwenLM/qwen-code/issues/11704#issuecomment-5807811203)仍把凭据撤销、后台 SSE 与通知列为未完成。本说明不转移该工作归属，也不绕过贡献准入要求。

建议的最小贡献是在 daemon 负责人确认契约之后，单独约定验收夹具或实现切片。不得扩展尚未合并的下载 PR #12130 或飞书覆盖 PR #13278。冻结的 Phase 2 处置记录 #13111 不是本工作的交付待办。

## 当前行为

维护者编写的 [#12322](https://github.com/QwenLM/qwen-code/pull/12322) 已为主监听器加入独立 Web Shell 设备凭据。应复用该路径，而不是另建 Android token 系统。[现有设计](web-shell-dynamic-pairing.zh-CN.md)明确延期单设备撤销和设备管理 UI。

- 主监听器接受 runtime bearer 和经过哈希的 Web Shell 设备 bearer。Local Control 只接受其独立配对凭据，不接受上述两类主监听器凭据。
- 二维码邀请有效期为 60 秒且只能兑换一次。兑换生成 32 字节随机设备 bearer。最多保留 64 个有效邀请和 128 个设备 bearer；达到上限时拒绝新配对，不驱逐既有设备。
- 设备凭据属于 app 的内存 store。受支持的 trust/environment reload 会保留该 app；daemon 重启（包括 `execve` 替换）会清除设备凭据。现有设计称之为进程级访问。邀请过期不会使已经兑换的设备 bearer 过期。此生命周期来自源码审查，store 探针没有执行真实重启。
- 设备存储是摘要集合，没有稳定设备 ID、列表操作或单设备撤销操作。HTTP 认证成功后只保留布尔值，不保留凭据身份。
- 已配对的主监听器 bearer 目前可签发新邀请。Desktop relay 凭据也会独立派生，未记录签发者或设备谱系。只删除一个摘要，不能定义后代设备或尚未使用的派生凭据应如何处理。
- Android 用现有加密 profile vault 保存所提供的凭据。删除本地 profile 不会撤销 daemon 访问权限；当前 UI 和 README 已正确说明。

这是明确延期的功能，不表示当前实现承诺单设备撤销，也不表示真实租户已经遭遇安全事件。

## 消费者与生命周期边界

| 边界                       | 现有源码                                                                                     | 声称支持撤销前须满足的要求                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 进程全局主监听器 REST      | `packages/cli/src/serve/auth.ts`、`server.ts`                                                | 保持 runtime、设备与 Local Control 隔离；使用经过认证的凭据身份，不能使用调用方自报的 client ID。                 |
| 远程同源校验               | `server/self-origin.ts`                                                                      | 保持 Host、Origin 与认证前例外；被撤销凭据不能继续满足同源凭据检查。                                              |
| 新 WebSocket 准入          | `acp-http/index.ts`                                                                          | 保留 ACP、workspace ACP、CDP、语音与额外 live 路由共享的入口；无论 header 或 subprotocol 传输，都拒绝已撤销凭据。 |
| 既有 SSE 与 WebSocket 连接 | `routes/sse-events.ts`、`routes/session-agents.ts`、`routes/session.ts`、`acp-http/index.ts` | 决定并验证定向关闭语义。现有准入不保留供后续撤销使用的设备主体；关闭整个主监听器不等于选择性撤销。                |
| 仅 root 可用的 daemon 更新 | `routes/daemon-update.ts`                                                                    | 保持有意设置的 runtime 凭据专属权限，不能扩展给已配对浏览器。                                                     |
| 冷启动、重启与 reload      | `run-qwen-serve.ts`                                                                          | 与 daemon 负责人一起决定持久化和 reload 行为；当前进程级 token 不能静默变为持久凭据或获得 bootstrap 权限。        |
| Local Control              | `local-control/service.ts`                                                                   | 保持独立 LAN 撤销和监听器清理；这不是主监听器单设备撤销实现。                                                     |

若获批准，新的管理面属于进程全局，而非 workspace 级。撤销一个凭据不能误停其他设备，也不能回退到 primary workspace runtime。

## 需要 daemon 负责人决定的问题

1. 哪类已认证主体可以列举和撤销设备：仅 root operator、自我撤销，还是当前所有 bearer 等同 operator 的模型？开放 loopback 部署对应何种管理权限？
2. 稳定且非秘密的设备标识是什么，注册表是进程级还是持久化？不能把 token 摘要、bearer 或未经信任的客户端标签变成公开标识或日志。
3. 撤销是否立即终止现有访问，还是仅拒绝新准入？“丢失设备”的承诺必须明确覆盖既有 SSE/WS，而不是只检查一次新的 HTTP 请求。
4. 如何处理该设备签发的未兑换邀请、已配对后代与未使用的 desktop relay 凭据？
5. 撤销是停止底层 agent 工作，还是仅停止客户端的观察和控制？应明确 prompt、permission 与进行中响应的行为，且重连不能造成重复工作。
6. 哪些路由名、capability/version 标记、响应及错误契约、审计字段和安全审查符合跟踪项 [#4514 T2.2/T3.6](https://github.com/QwenLM/qwen-code/issues/4514)？不要另建一次性的 token store。

本交接不预设上述问题的答案。尤其不能在所有 bearer 只留下“已认证”布尔值时，直接把公开 delete 路由作为第一份补丁。

## 范围确认后的验收矩阵

使用合成凭据和本地、无模型调用的 daemon 夹具。复用现有配对与 transport 夹具，不要把其实现复制成另一套服务器。

- 独立配对 A、B；撤销前两者都能使用已发布的 REST+SSE 客户端接口。runtime 与 Local Control 范围控制保持既有结果。
- 通过获批权限撤销 A。A 的新 REST 与 WebSocket 准入失败，B 和 runtime operator 仍可用。伪造 client-ID header，或把 A 的 bearer 送到另一个监听器，不能恢复访问。
- 对 A 的普通、session-agent、generation SSE 和 WS 应用约定的既有流规则。B 的实时流保持连接。每个订阅或 socket 恰好清理一次，包括 disconnect/revoke 竞争与背压。
- 应用约定的后代、邀请和 relay 规则。未使用的派生凭据不能意外绕过该规则。
- 保留邀请过期、单次使用、origin 检查、限流、容量拒绝、无 token loopback 和 restart/reload 兼容性。明确撤销是否释放容量。
- 只返回获批的非秘密元数据。路由、日志、断言失败、截图和报告不得输出 bearer、摘要、邀请或加密 vault 值。
- 服务器撤销真正实现并集成之前，保留 Android profile 删除的现有说明。不能因设计、store 探针或已编译 instrumentation APK 就宣称开发外壳已达到官方客户端发布标准。

## 验证状态与限制

本变更仅包含文档。静态源码审查已完成；独立的 store 级基线探针另存于 `.qwen/investigations/device-revocation/`。store 级探针不执行真实 HTTP、SSE、WebSocket 或 Android 生命周期。

本环境 PATH 中没有全局 `qwen` 可执行文件。要求的全局 CLI dry-run、完整 daemon 验收矩阵、Android 进程及后台测试、截图和修复前后验证均未执行。本变更不含生产实现、凭据修改或真实 provider 调用。E2E 计划位于 `.qwen/e2e-tests/mobile-device-revocation.md`；结果必须按测试层次分别记录。
