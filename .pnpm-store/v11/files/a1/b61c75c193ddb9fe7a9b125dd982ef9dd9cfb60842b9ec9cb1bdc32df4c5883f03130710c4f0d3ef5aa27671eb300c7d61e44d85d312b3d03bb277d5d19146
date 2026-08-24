const addIndent = (str, spaces = 2, initialIndent = false) => {
  const indent = " ".repeat(spaces);
  const lines = str.split("\n");
  return lines.map((line, index) => {
    if (index === 0 && !initialIndent) {
      return line;
    }
    return `${indent}${line}`;
  }).join("\n");
};
const getStyles = (configuration, customTheme) => {
  const styles = [];
  if (configuration.customCss) {
    styles.push("/* Custom CSS */");
    styles.push(configuration.customCss);
  }
  if (!configuration.theme && customTheme) {
    styles.push("/* Custom Theme */");
    styles.push(customTheme);
  }
  if (styles.length === 0) {
    return "";
  }
  return `
    <style type="text/css">
      ${addIndent(styles.join("\n\n"), 6)}
    </style>`;
};
const getHtmlDocument = (givenConfiguration, customTheme = "") => {
  const { cdn, pageTitle, customCss, theme, ...rest } = givenConfiguration;
  const configuration = getConfiguration({
    ...rest,
    ...theme ? { theme } : {},
    customCss
  });
  const content = `<!doctype html>
<html>
  <head>
    <title>${pageTitle ?? "Scalar API Reference"}</title>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1" />${getStyles(configuration, customTheme)}
  </head>
  <body>
    <div id="app"></div>${getScriptTags(configuration, cdn)}
  </body>
</html>`;
  return content;
};
const serializeArrayWithFunctions = (arr) => {
  return `[${arr.map((item) => typeof item === "function" ? item.toString() : JSON.stringify(item)).join(", ")}]`;
};
function getScriptTags(configuration, cdn) {
  const restConfig = { ...configuration };
  const functionProps = [];
  for (const [key, value] of Object.entries(configuration)) {
    if (typeof value === "function") {
      functionProps.push(`"${key}": ${value.toString()}`);
      delete restConfig[key];
    } else if (Array.isArray(value) && value.some((item) => typeof item === "function")) {
      functionProps.push(`"${key}": ${serializeArrayWithFunctions(value)}`);
      delete restConfig[key];
    }
  }
  const configString = JSON.stringify(restConfig, null, 2).split("\n").map((line, index) => index === 0 ? line : "      " + line).join("\n").replace(/\s*}$/, "");
  const functionPropsString = functionProps.length ? `,
        ${functionProps.join(",\n        ")}
      }` : "}";
  return `
    <!-- Load the Script -->
    <script src="${cdn ?? "https://cdn.jsdelivr.net/npm/@scalar/api-reference"}"><\/script>

    <!-- Initialize the Scalar API Reference -->
    <script type="text/javascript">
      Scalar.createApiReference('#app', ${configString}${functionPropsString})
    <\/script>`;
}
const getConfiguration = (givenConfiguration) => {
  const configuration = {
    ...givenConfiguration
  };
  if (typeof configuration.content === "function") {
    configuration.content = configuration.content();
  }
  if (configuration.content && configuration.url) {
    delete configuration.content;
  }
  return configuration;
};
export {
  getConfiguration,
  getHtmlDocument,
  getScriptTags
};
//# sourceMappingURL=html-rendering.js.map
