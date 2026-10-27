import { z } from "zod";
const name = z.string().min(1);
export const inputIntentSchema = z
  .object({
    location: z.enum(["PATH", "QUERY", "BODY", "HEADER"]),
    path: name,
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("VALUE"), value: z.unknown() }).strict(),
      z
        .object({
          kind: z.literal("RECORDING"),
          requestId: name.nullish(),
          path: name.nullish(),
        })
        .strict(),
      z
        .object({ kind: z.literal("RESPONSE"), fromCall: name, path: name })
        .strict(),
    ]),
  })
  .strict();
export const callIntentSchema = z
  .object({
    calls: z
      .array(
        z
          .object({
            id: name,
            semanticStepRef: name,
            apiId: name,
            requestId: name.nullish(),
            dependsOn: z.array(name),
            inputs: z.array(inputIntentSchema).default([]),
            checks: z
              .array(
                z
                  .object({
                    kind: z.enum(["status", "json"]),
                    path: name.nullish(),
                    operator: z.enum([
                      "eq",
                      "exists",
                      "notExists",
                      "contains",
                      "notContains",
                    ]),
                    value: z.unknown().optional(),
                  })
                  .strict(),
              )
              .default([]),
          })
          .strict(),
      )
      .min(1),
    uncertainties: z.array(z.string()).default([]),
  })
  .strict();
export type CallIntent = z.infer<typeof callIntentSchema>;
export const intentInstructions =
  "把已确认用例映射为调用意图，不输出 Plan。每个 API 语义步骤必须有调用，semanticStepRef 原样引用已有 API 步骤。仅使用选中的 apiId 和该接口 requestId；默认沿用整份录制请求，不重写请求体或 Header。inputs 仅列场景真正需要改变的字段：VALUE 为新的测试值（待审核），RECORDING 为录制来源，RESPONSE 明确 fromCall 和响应字段并保留上游依赖。Header 仅可引用真实上游响应；认证和采集默认 Header 由程序处理。checks 仅提出有已确认用例或实际响应依据的预期；不要把业务 code 当 HTTP 状态码。数组中存在/不存在匹配记录用 JSON checks：path 指向数组，operator=contains/notContains，value 是要匹配的字段对象（字段必须在录制响应中出现），不写 JSONPath 过滤表达式。路径只支持 $.field 和 $[0].field，不支持通配符、过滤器。不要生成 SETUP/CLEANUP、资源变量、认证上下文、重试、超时、并发或身份版本字段；资源生命周期由编译器验证实际接口证据后处理。不知道的业务行为写入 uncertainties，不得假设 save 支持 action=delete。";
