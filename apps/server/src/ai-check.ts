import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfiguredAIProvider } from "./ai-config.js";
import {
  ModelAIProvider,
  type AIProvider,
} from "../../../packages/planner/src/index.js";

export async function runAIConnectivityCheck(
  configPath?: string,
  log: (message: string) => void = console.log,
): Promise<number> {
  let provider: AIProvider | undefined;
  try {
    provider = createConfiguredAIProvider(configPath);
    if (!(provider instanceof ModelAIProvider))
      throw new Error(
        "当前配置为 Mock，不能验证真实模型连接。请在 config/ai.json 选择 openai-compatible。",
      );
    log(
      `正在测试模型 ${provider.version}，读取配置 ${configPath ?? "config/ai.json"}；不读取录制数据。`,
    );
    const result = await provider.checkConnection();
    log(
      `模型连接测试成功：${result.endpoint}，model=${result.model}，耗时 ${result.durationMs} ms，返回 ${result.responseCharacters} 个字符。`,
    );
    log("已验证真实聊天接口返回有效响应；完整 Case/Plan 生成仍需单独验证。");
    return 0;
  } catch (error) {
    log(
      `模型连接测试失败：${error instanceof Error ? error.message : "Unknown model error"}`,
    );
    return 1;
  } finally {
    await provider?.close?.();
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const index = process.argv.indexOf("--config");
  if (index >= 0 && !process.argv[index + 1]) {
    console.error("--config 后需要配置文件路径");
    process.exitCode = 1;
  } else
    process.exitCode = await runAIConnectivityCheck(
      index < 0 ? undefined : resolve(process.argv[index + 1]),
    );
}
