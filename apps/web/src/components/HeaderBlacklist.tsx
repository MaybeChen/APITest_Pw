import { useEffect, useState } from "react";
const parse = (text: string) => text.split(/[\s,，]+/).filter(Boolean);
export function HeaderBlacklist({
  value,
  onChange,
}: {
  value: string[];
  onChange: (names: string[]) => void;
}) {
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => {
    // Preserve trailing newlines while typing; synchronize external JSON changes.
    setText((current) =>
      JSON.stringify(parse(current)) === JSON.stringify(value)
        ? current
        : value.join("\n"),
    );
  }, [value]);
  return (
    <label>
      API 请求 Header 黑名单
      <textarea
        aria-label="API 请求 Header 黑名单"
        value={text}
        placeholder="可选；每行一个字段名，例如 x-gde-src-page；不区分大小写"
        onChange={(event) => {
          setText(event.target.value);
          onChange(parse(event.target.value));
        }}
      />
      <small>保存配置后对后续 API 执行生效，不影响前置 UI 登录和录制。</small>
    </label>
  );
}
