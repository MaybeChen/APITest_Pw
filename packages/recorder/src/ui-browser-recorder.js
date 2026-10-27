(() => {
  if (window !== window.top || window.__uiRecorderInstalled) return;
  window.__uiRecorderInstalled = true;
  let lastEnter = 0;
  const selector = (element) => {
    const tag = element.tagName.toLowerCase();
    if (
      element.id &&
      document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1
    )
      return `#${CSS.escape(element.id)}`;
    for (const attr of ["data-testid", "name", "aria-label"]) {
      const value = element.getAttribute(attr);
      if (value) {
        const candidate = `${tag}[${attr}=${JSON.stringify(value)}]`;
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      }
    }
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement) {
      const index =
        Array.from(current.parentElement?.children ?? [])
          .filter((child) => child.tagName === current.tagName)
          .indexOf(current) + 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index})`);
      current = current.parentElement;
    }
    return `html > ${parts.join(" > ")}`;
  };
  const send = (event) => {
    void window.__uiRecord(event).catch(() => {});
  };
  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      if (event.detail === 0 && Date.now() - lastEnter < 1000) return;
      const element = event.target.closest(
        "button,a,input[type=checkbox],input[type=radio],input[type=submit],input[type=button],[role=button],[role=tab],[role=menuitem],[onclick],[tabindex]",
      );
      if (element) send({ type: "click", target: selector(element) });
    },
    true,
  );
  document.addEventListener(
    "input",
    (event) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const element = event.target;
      if (
        element.matches(
          "input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]):not([type=submit]),textarea,[contenteditable=true]",
        )
      )
        send({
          type: "fill",
          target: selector(element),
          value: element.isContentEditable
            ? (element.textContent ?? "")
            : element.value,
        });
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      if (event.target instanceof HTMLSelectElement)
        send({
          type: "selectOption",
          target: selector(event.target),
          value: event.target.value,
        });
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.isTrusted &&
        event.key === "Enter" &&
        event.target instanceof HTMLInputElement
      ) {
        lastEnter = Date.now();
        send({ type: "press", target: selector(event.target), value: "Enter" });
      }
    },
    true,
  );
})();
