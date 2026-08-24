import { _codeFrameColumns } from './common-shared.js';
import { styleText } from 'node:util';
import jsTokens from 'js-tokens';
import { isKeyword, isStrictReservedWord } from '@babel/helper-validator-identifier';

function isColorSupported() {
  return styleText("red", "-") !== "-";
}
function createFormatter(format) {
  return input => styleText(format, String(input ?? ""), {
    validateStream: false
  });
}
const defs = {
  keyword: createFormatter("cyan"),
  capitalized: createFormatter("yellow"),
  jsxIdentifier: createFormatter("yellow"),
  punctuator: createFormatter("yellow"),
  number: createFormatter("magenta"),
  string: createFormatter("green"),
  regex: createFormatter("magenta"),
  comment: createFormatter("gray"),
  invalid: createFormatter(["white", "bgRed", "bold"]),
  gutter: createFormatter("gray"),
  marker: createFormatter(["red", "bold"]),
  message: createFormatter(["red", "bold"]),
  reset: createFormatter("reset")
};

const sometimesKeywords = new Set(["as", "async", "from", "get", "of", "set"]);
const NEWLINE = /\r\n|[\n\r\u2028\u2029]/;
const BRACKET = /^[()[\]{}]$/;
const getTokenType = function (token) {
  if (token.type === "IdentifierName") {
    const tokenValue = token.value;
    if (isKeyword(tokenValue) || isStrictReservedWord(tokenValue, true) || sometimesKeywords.has(tokenValue)) {
      return "keyword";
    }
    const firstChar = tokenValue.charCodeAt(0);
    if (firstChar < 128) {
      if (firstChar >= 65 && firstChar <= 90) {
        return "capitalized";
      }
    } else {
      const firstChar = String.fromCodePoint(tokenValue.codePointAt(0));
      if (firstChar !== firstChar.toLowerCase()) {
        return "capitalized";
      }
    }
  }
  if (token.type === "Punctuator" && BRACKET.test(token.value)) {
    return "uncolored";
  }
  if (token.type === "Invalid" && token.value === "@") {
    return "punctuator";
  }
  switch (token.type) {
    case "NumericLiteral":
      return "number";
    case "StringLiteral":
    case "JSXString":
    case "NoSubstitutionTemplate":
      return "string";
    case "RegularExpressionLiteral":
      return "regex";
    case "Punctuator":
    case "JSXPunctuator":
      return "punctuator";
    case "MultiLineComment":
    case "SingleLineComment":
      return "comment";
    case "Invalid":
    case "JSXInvalid":
      return "invalid";
    case "JSXIdentifier":
      return "jsxIdentifier";
    default:
      return "uncolored";
  }
};
function* tokenize(text) {
  for (const token of jsTokens(text, {
    jsx: true
  })) {
    switch (token.type) {
      case "TemplateHead":
        yield {
          type: "string",
          value: token.value.slice(0, -2)
        };
        yield {
          type: "punctuator",
          value: "${"
        };
        break;
      case "TemplateMiddle":
        yield {
          type: "punctuator",
          value: "}"
        };
        yield {
          type: "string",
          value: token.value.slice(1, -2)
        };
        yield {
          type: "punctuator",
          value: "${"
        };
        break;
      case "TemplateTail":
        yield {
          type: "punctuator",
          value: "}"
        };
        yield {
          type: "string",
          value: token.value.slice(1)
        };
        break;
      default:
        yield {
          type: getTokenType(token),
          value: token.value
        };
    }
  }
}
function highlight(text) {
  if (text === "") return "";
  let highlighted = "";
  for (const {
    type,
    value
  } of tokenize(text)) {
    if (type in defs) {
      highlighted += value.split(NEWLINE).map(str => defs[type](str)).join("\n");
    } else {
      highlighted += value;
    }
  }
  return highlighted;
}

function codeFrameColumns(rawLines, loc, opts = {}) {
  const shouldHighlight = opts.forceColor || isColorSupported() && opts.highlightCode;
  return _codeFrameColumns(rawLines, loc, opts, shouldHighlight ? {
    defs,
    highlight
  } : undefined);
}

export { codeFrameColumns, highlight };
//# sourceMappingURL=index.js.map
