import { TSESTree as T, TSESLint, ASTUtils } from "@typescript-eslint/utils";
import type { FunctionNode } from "../utils";

const isNothing = (node?: T.Node): boolean => {
  if (!node) {
    return true;
  }
  switch (node.type) {
    case "Literal":
      return ([null, undefined, false, ""] as Array<unknown>).includes(node.value);
    case "JSXFragment":
      return !node.children || node.children.every(isNothing);
    default:
      return false;
  }
};

const getLocLength = (loc: T.SourceLocation) => loc.end.line - loc.start.line + 1;

const rule: TSESLint.RuleModule<"noEarlyReturn" | "noConditionalReturn", []> = {
  meta: {
    type: "problem",
    docs: {
      recommended: "error",
      description:
        "Disallow early returns in components. Solid components only run once, and so conditionals should be inside JSX.",
      url: "https://github.com/joshwilsonvu/eslint-plugin-solid/blob/main/docs/components-return-once.md",
    },
    fixable: "code",
    schema: [],
    messages: {
      noEarlyReturn:
        "Solid components run once, so an early return breaks reactivity. Move the condition inside a JSX element, such as a fragment or <Show />.",
      noConditionalReturn:
        "Solid components run once, so a conditional return breaks reactivity. Move the condition inside a JSX element, such as a fragment or <Show />.",
    },
  },
  create(context) {
    const functionStack: Array<{
      /** switched to true by :exit if the current function is detected to be a component */
      isComponent: boolean;
      lastReturn: T.ReturnStatement | undefined;
      earlyReturns: Array<T.ReturnStatement>;
    }> = [];
    const putIntoJSX = (node: T.Node): string => {
      const text = context.getSourceCode().getText(node);
      return node.type === "JSXElement" || node.type === "JSXFragment" ? text : `{${text}}`;
    };
    const currentFunction = () => functionStack[functionStack.length - 1];
    const onFunctionEnter = (node: FunctionNode) => {
      const getLastReturn = () => {
        if (node.body.type === "BlockStatement") {
          const { length } = node.body.body;
          const last = length && node.body.body[length - 1];
          if (last && last.type === "ReturnStatement") {
            return last;
          }
        }
      };
      functionStack.push({ isComponent: false, lastReturn: getLastReturn(), earlyReturns: [] });
    };
    const onFunctionExit = (node: FunctionNode) => {
      if (
        node.parent?.type === "JSXExpressionContainer" // "render props" aren't components
      ) {
        currentFunction().isComponent = false;
      }
      if (currentFunction().isComponent) {
        currentFunction().earlyReturns.forEach((earlyReturn) => {
          context.report({
            node: earlyReturn,
            messageId: "noEarlyReturn",
          });
        });

        const argument = currentFunction().lastReturn?.argument;
        if (argument?.type === "ConditionalExpression") {
          const sourceCode = context.getSourceCode();
          context.report({
            node: argument.parent!,
            messageId: "noConditionalReturn",
            fix: (fixer) => {
              const { test, consequent, alternate } = argument;
              const conditions = [{ test, consequent }];
              let fallback = alternate;

              while (fallback.type === "ConditionalExpression") {
                conditions.push({ test: fallback.test, consequent: fallback.consequent });
                fallback = fallback.alternate;
              }

              if (conditions.length >= 2) {
                // we have a nested ternary, use <Switch><Match /></Switch>
                const fallbackStr = !isNothing(fallback)
                  ? ` fallback={${sourceCode.getText(fallback)}}`
                  : "";
                return fixer.replaceText(
                  argument,
                  `<Switch${fallbackStr}>\n${conditions
                    .map(
                      ({ test, consequent }) =>
                        `<Match when={${sourceCode.getText(test)}}>${putIntoJSX(
                          consequent
                        )}</Match>`
                    )
                    .join("\n")}\n</Switch>`
                );
              }
              if (isNothing(consequent)) {
                // we have a single ternary and the consequent is nothing. Negate the condition and use a <Show>.
                return fixer.replaceText(
                  argument,
                  `<Show when={!(${sourceCode.getText(test)})}>${putIntoJSX(alternate)}</Show>`
                );
              }
              if (
                isNothing(fallback) ||
                getLocLength(consequent.loc) >= getLocLength(alternate.loc) * 1.5
              ) {
                // we have a standard ternary, and the alternate is a bit shorter in LOC than the consequent, which
                // should be enough to tell that it's logically a fallback instead of an equal branch.
                const fallbackStr = !isNothing(fallback)
                  ? ` fallback={${sourceCode.getText(fallback)}}`
                  : "";
                return fixer.replaceText(
                  argument,
                  `<Show when={${sourceCode.getText(test)}}${fallbackStr}>${putIntoJSX(
                    consequent
                  )}</Show>`
                );
              }

              // we have a standard ternary, but no signal from the user as to which branch is the "fallback" and
              // which is the children. Move the whole conditional inside a JSX fragment.
              return fixer.replaceText(argument, `<>${putIntoJSX(argument)}</>`);
            },
          });
        }
      }

      // Pop on exit
      functionStack.pop();
    };
    return {
      FunctionDeclaration: onFunctionEnter,
      FunctionExpression: onFunctionEnter,
      ArrowFunctionExpression: onFunctionEnter,
      "FunctionDeclaration:exit": onFunctionExit,
      "FunctionExpression:exit": onFunctionExit,
      "ArrowFunctionExpression:exit": onFunctionExit,
      JSXElement() {
        if (functionStack.length) {
          currentFunction().isComponent = true;
        }
      },
      JSXFragment() {
        if (functionStack.length) {
          currentFunction().isComponent = true;
        }
      },
      ReturnStatement(node) {
        if (functionStack.length && node !== currentFunction().lastReturn) {
          currentFunction().earlyReturns.push(node);
        }
      },
    };
  },
};

export default rule;
