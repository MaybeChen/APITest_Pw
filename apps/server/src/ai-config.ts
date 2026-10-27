import { createModelLogger } from "../../../packages/planner/src/logging.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as tls from "node:tls";
import { EnvHttpProxyAgent, fetch as httpFetch } from "undici";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  ModelAIProvider,
  MockAIProvider,
  type AIProvider,
} from "../../../packages/planner/src/index.js";

export const aiConfigSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("mock") }),
  z.object({
    provider: z.literal("openai-compatible"),
    baseURL: z
      .string()
      .url()
      .refine((value) => {
        const u = new URL(value);
        return (
          ["http:", "https:"].includes(u.protocol) &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash
        );
      }, "Model baseURL must be an HTTP/HTTPS URL without credentials, query or fragment"),
    model: z.string().trim().min(1),
    timeoutMs: z.number().int().min(100).max(600000).default(600000),
    responseFormat: z.enum(["json_object", "none"]).default("json_object"),
    apiKeyEnv: z.string().min(1).optional(),
    caFile: z.string().min(1).optional(),
    ignoreHTTPSErrors: z.boolean().default(false),
    planningLimits: z
      .object({
        inputBudget: z.number().int().min(16000).max(200000).default(64000),
        maxOutputTokens: z.number().int().min(512).max(16384).default(8192),
        maxInterfacesPerBatch: z.number().int().min(1).max(30).default(6),
      })
      .default({
        inputBudget: 64000,
        maxOutputTokens: 8192,
        maxInterfacesPerBatch: 6,
      }),
    logging: z
      .object({
        enabled: z.boolean().default(false),
        console: z.boolean().default(true),
        file: z.string().min(1).optional(),
        maxChars: z.number().int().min(100).max(1000000).default(64000),
        maxFileBytes: z
          .number()
          .int()
          .min(1024)
          .max(104857600)
          .default(10485760),
        backups: z.number().int().min(1).max(10).default(3),
      })
      .default({
        enabled: false,
        console: true,
        maxChars: 64000,
        maxFileBytes: 10485760,
        backups: 3,
      }),
  }),
]);
export function createConfiguredAIProvider(
  path = fileURLToPath(new URL("../../../config/ai.json", import.meta.url)),
  variables: NodeJS.ProcessEnv = process.env,
): AIProvider {
  const config = aiConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (config.provider === "mock") return new MockAIProvider();
  const apiKeyName = config.apiKeyEnv;
  if (apiKeyName && !variables[apiKeyName])
    throw new Error(
      `Missing model credential environment variable: ${apiKeyName}`,
    );
  const endpoint = config.baseURL.replace(/\/+$/, "") + "/chat/completions";
  const ca =
    !config.ignoreHTTPSErrors && config.caFile
      ? [
          ...(tls.getCACertificates?.("default") ?? tls.rootCertificates),
          readFileSync(resolve(dirname(path), config.caFile), "utf8"),
        ]
      : undefined;
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: variables.http_proxy ?? variables.HTTP_PROXY ?? "",
    httpsProxy: variables.https_proxy ?? variables.HTTPS_PROXY ?? "",
    noProxy: variables.no_proxy ?? variables.NO_PROXY ?? "",
    connect: {
      ...(ca ? { ca } : {}),
      rejectUnauthorized: !config.ignoreHTTPSErrors,
    },
    requestTls: {
      ...(ca ? { ca } : {}),
      rejectUnauthorized: !config.ignoreHTTPSErrors,
    },
  });
  return new ModelAIProvider({
    endpoint,
    planningLimits: config.planningLimits,
    logger: createModelLogger(
      {
        ...config.logging,
        file: config.logging.file
          ? resolve(dirname(path), config.logging.file)
          : undefined,
      },
      apiKeyName ? [variables[apiKeyName]!] : [],
    ),
    model: config.model,
    timeoutMs: config.timeoutMs,
    responseFormat: config.responseFormat,
    apiKey: apiKeyName ? variables[apiKeyName] : undefined,
    requester: (url, options) => httpFetch(url, { ...options, dispatcher }),
    close: () => dispatcher.close(),
  });
}
