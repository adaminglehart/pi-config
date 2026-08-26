import { type Api, type Model, StringEnum, type UserMessage } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { requestDesktopNotification } from "./_lib/desktop-notification.js";

const QuestionKindSchema = StringEnum(["single", "multiple", "text"] as const);

const OptionSchema = Type.Object({
  value: Type.String({ description: "Stable value returned for this option" }),
  label: Type.String({ description: "Option text shown to the user" }),
  description: Type.Optional(
    Type.String({ description: "Optional explanation shown below the option" }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier used in the structured result" }),
  label: Type.Optional(
    Type.String({ description: "Short label used for navigation and answer summaries" }),
  ),
  prompt: Type.String({ description: "Question shown to the user" }),
  type: QuestionKindSchema,
  options: Type.Optional(
    Type.Array(OptionSchema, {
      description: "Options for single- and multiple-choice questions",
    }),
  ),
  allowOther: Type.Optional(
    Type.Boolean({
      description: "Let the user enter an answer that is not in the options",
      default: false,
    }),
  ),
});

const QuestionParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: 1,
    description: "One or more related questions to ask in one questionnaire",
  }),
});

type QuestionParams = Static<typeof QuestionParamsSchema>;

const EXTRACTION_PROVIDER = "openrouter";
const EXTRACTION_MODEL = "google/gemini-3-flash-preview";

const EXTRACTION_SYSTEM_PROMPT = `Extract all questions that need user input from the assistant message.

Return one JSON object with this structure:
{
  "questions": [
    {
      "id": "scope",
      "label": "Scope",
      "prompt": "Which parts should change?",
      "type": "multiple",
      "options": [
        { "value": "api", "label": "API" },
        { "value": "ui", "label": "UI", "description": "User interface only" }
      ],
      "allowOther": true
    }
  ]
}

Rules:
- Keep questions in their original order.
- Use type "single" when the user must select one option.
- Use type "multiple" when the user can select more than one option.
- Use type "text" when there are no clear options.
- Include options only for single- and multiple-choice questions.
- Give each option a short stable value and its original display label.
- Put essential context in the prompt or an option description.
- Use short unique ids and short labels.
- Set allowOther to true only when a different answer is useful.
- If there are no questions, return {"questions":[]}.
- Return JSON only.`;

async function selectExtractionModel(
  currentModel: Model<Api>,
  modelRegistry: ModelRegistry,
): Promise<Model<Api>> {
  const extractionModel = modelRegistry.find(EXTRACTION_PROVIDER, EXTRACTION_MODEL);
  if (!extractionModel) {
    return currentModel;
  }

  const apiKey = await modelRegistry.getApiKeyForProvider(extractionModel.provider);
  return apiKey ? extractionModel : currentModel;
}

function parseExtractionResult(text: string): QuestionParams | null {
  try {
    const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const json = codeBlock?.[1]?.trim() ?? text.trim();
    const parsed: QuestionParams = JSON.parse(json);

    if (!parsed || !Array.isArray(parsed.questions)) {
      return null;
    }
    normalizeQuestions(parsed);
    return parsed;
  } catch {
    return null;
  }
}
type QuestionKind = Static<typeof QuestionKindSchema>;

type QuestionOption = Static<typeof OptionSchema>;

interface Question {
  id: string;
  label: string;
  prompt: string;
  type: QuestionKind;
  options: QuestionOption[];
  allowOther: boolean;
}

interface ChoiceSelection {
  value: string;
  label: string;
  isCustom: boolean;
}

interface SingleAnswer {
  id: string;
  type: "single";
  selection: ChoiceSelection;
}

interface MultipleAnswer {
  id: string;
  type: "multiple";
  selections: ChoiceSelection[];
}

interface TextAnswer {
  id: string;
  type: "text";
  value: string;
}

type Answer = SingleAnswer | MultipleAnswer | TextAnswer;

interface QuestionDetails {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

function normalizeQuestions(params: QuestionParams): Question[] {
  const ids = new Set<string>();

  return params.questions.map((input, questionIndex) => {
    const id = input.id.trim();
    const prompt = input.prompt.trim();

    if (
      input.type !== "single" &&
      input.type !== "multiple" &&
      input.type !== "text"
    ) {
      throw new Error(`Question ${questionIndex + 1} has an invalid type`);
    }
    if (id.length === 0) {
      throw new Error(`Question ${questionIndex + 1} has an empty id`);
    }
    if (ids.has(id)) {
      throw new Error(`Question id must be unique: ${id}`);
    }
    if (prompt.length === 0) {
      throw new Error(`Question ${id} has an empty prompt`);
    }
    ids.add(id);

    const options = input.options ?? [];
    if (input.type !== "text" && options.length === 0) {
      throw new Error(`Question ${id} requires at least one option`);
    }

    const optionValues = new Set<string>();
    const normalizedOptions = options.map((option, optionIndex) => {
      const value = option.value.trim();
      const label = option.label.trim();

      if (value.length === 0) {
        throw new Error(`Option ${optionIndex + 1} in question ${id} has an empty value`);
      }
      if (label.length === 0) {
        throw new Error(`Option ${optionIndex + 1} in question ${id} has an empty label`);
      }
      if (optionValues.has(value)) {
        throw new Error(`Option values must be unique in question ${id}: ${value}`);
      }
      optionValues.add(value);

      return {
        value,
        label,
        description: option.description?.trim() || undefined,
      };
    });

    return {
      id,
      label: input.label?.trim() || `Q${questionIndex + 1}`,
      prompt,
      type: input.type,
      options: normalizedOptions,
      allowOther: input.type !== "text" && input.allowOther === true,
    };
  });
}

function isComplete(question: Question, answer: Answer | undefined): boolean {
  if (!answer || answer.id !== question.id || answer.type !== question.type) {
    return false;
  }

  if (answer.type === "text") {
    return answer.value.trim().length > 0;
  }
  if (answer.type === "multiple") {
    return answer.selections.length > 0;
  }
  return answer.selection.value.length > 0;
}

function summarizeAnswer(question: Question, answer: Answer): string {
  if (answer.type === "text") {
    return `${question.label} (${question.id}): user wrote: ${answer.value}`;
  }

  if (answer.type === "single") {
    if (answer.selection.isCustom) {
      return `${question.label} (${question.id}): user wrote: ${answer.selection.label}`;
    }
    return `${question.label} (${question.id}): user selected: ${answer.selection.label} (value: ${answer.selection.value})`;
  }

  const selections = answer.selections.map((selection) =>
    selection.isCustom
      ? `user wrote: ${selection.label}`
      : `${selection.label} (value: ${selection.value})`,
  );
  return `${question.label} (${question.id}): user selected: ${selections.join(", ")}`;
}

function getAnswerLabel(answer: Answer): string {
  if (answer.type === "text") {
    return answer.value;
  }
  if (answer.type === "single") {
    return answer.selection.label;
  }
  return answer.selections.map((selection) => selection.label).join(", ");
}

export default function question(pi: ExtensionAPI) {
  function presentQuestions(
    questions: Question[],
    ctx: ExtensionContext,
    allowIncomplete = false,
  ): Promise<QuestionDetails> {
    if (ctx.mode !== "tui") {
      throw new Error("question requires interactive TUI mode");
    }
    requestDesktopNotification(pi, {
      title: "π Question",
      body: questions.length === 1
        ? "Pi is waiting for your answer"
        : "Pi is waiting for your answers",
    });

    return ctx.ui.custom<QuestionDetails>((tui, theme, _keybindings, done) => {
        let currentIndex = 0;
        let optionIndex = 0;
        let otherInput = false;
        let validationMessage: string | undefined;
        let cachedWidth: number | undefined;
        let cachedLines: string[] | undefined;
        const answers = new Map<string, Answer>();

        const editorTheme: EditorTheme = {
          borderColor: (text) => theme.fg("accent", text),
          selectList: {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          },
        };
        const editor = new Editor(tui, editorTheme);
        editor.disableSubmit = true;
        editor.onChange = () => refresh();

        function refresh(): void {
          cachedWidth = undefined;
          cachedLines = undefined;
          tui.requestRender();
        }

        function currentQuestion(): Question | undefined {
          return questions[currentIndex];
        }

        function orderedAnswers(): Answer[] {
          return questions.flatMap((question) => {
            const answer = answers.get(question.id);
            return answer ? [answer] : [];
          });
        }

        function allComplete(): boolean {
          return (
            allowIncomplete ||
            questions.every((question) => isComplete(question, answers.get(question.id)))
          );
        }

        function setValidation(message?: string): void {
          validationMessage = message;
          refresh();
        }

        function loadEditorForCurrentQuestion(): void {
          const question = currentQuestion();
          if (!question || question.type !== "text") {
            editor.setText("");
            return;
          }

          const answer = answers.get(question.id);
          editor.setText(answer?.type === "text" ? answer.value : "");
        }

        function saveTextAnswer(): boolean {
          const question = currentQuestion();
          if (!question || question.type !== "text") {
            return true;
          }

          const value = editor.getText().trim();
          if (value.length === 0) {
            answers.delete(question.id);
            if (allowIncomplete) {
              validationMessage = undefined;
              return true;
            }
            setValidation("Enter an answer before you continue.");
            return false;
          }

          answers.set(question.id, { id: question.id, type: "text", value });
          validationMessage = undefined;
          return true;
        }

        function goTo(index: number): void {
          if (index < 0 || index > questions.length) {
            return;
          }

          const question = currentQuestion();
          if (question?.type === "text") {
            const value = editor.getText().trim();
            if (value.length > 0) {
              answers.set(question.id, { id: question.id, type: "text", value });
            } else {
              answers.delete(question.id);
            }
          }

          currentIndex = index;
          optionIndex = 0;
          otherInput = false;
          validationMessage = undefined;
          loadEditorForCurrentQuestion();
          refresh();
        }

        function advance(): void {
          goTo(Math.min(currentIndex + 1, questions.length));
        }

        function openOtherInput(): void {
          const question = currentQuestion();
          if (!question?.allowOther) {
            return;
          }

          const answer = answers.get(question.id);
          let existing = "";
          if (answer?.type === "single" && answer.selection.isCustom) {
            existing = answer.selection.label;
          } else if (answer?.type === "multiple") {
            existing = answer.selections.find((selection) => selection.isCustom)?.label ?? "";
          }

          otherInput = true;
          editor.setText(existing);
          validationMessage = undefined;
          refresh();
        }

        function saveOtherAnswer(): boolean {
          const question = currentQuestion();
          if (!question || question.type === "text") {
            return false;
          }

          const value = editor.getText().trim();
          if (value.length === 0) {
            setValidation("Enter a custom answer before you continue.");
            return false;
          }

          const selection: ChoiceSelection = { value, label: value, isCustom: true };
          if (question.type === "single") {
            answers.set(question.id, { id: question.id, type: "single", selection });
          } else {
            const answer = answers.get(question.id);
            const existing = answer?.type === "multiple" ? answer.selections : [];
            answers.set(question.id, {
              id: question.id,
              type: "multiple",
              selections: [...existing.filter((item) => !item.isCustom), selection],
            });
          }

          otherInput = false;
          editor.setText("");
          validationMessage = undefined;
          if (question.type === "single") {
            advance();
          } else {
            refresh();
          }
          return true;
        }

        function chooseSingle(question: Question, option: QuestionOption): void {
          answers.set(question.id, {
            id: question.id,
            type: "single",
            selection: { value: option.value, label: option.label, isCustom: false },
          });
          validationMessage = undefined;
          advance();
        }

        function toggleMultiple(question: Question, option: QuestionOption): void {
          const answer = answers.get(question.id);
          const selections = answer?.type === "multiple" ? answer.selections : [];
          const exists = selections.some(
            (selection) => !selection.isCustom && selection.value === option.value,
          );
          const nextSelections = exists
            ? selections.filter(
                (selection) => selection.isCustom || selection.value !== option.value,
              )
            : [
                ...selections,
                { value: option.value, label: option.label, isCustom: false },
              ];

          if (nextSelections.length === 0) {
            answers.delete(question.id);
          } else {
            answers.set(question.id, {
              id: question.id,
              type: "multiple",
              selections: nextSelections,
            });
          }
          validationMessage = undefined;
          refresh();
        }

        function toggleOtherMultiple(question: Question): void {
          const answer = answers.get(question.id);
          const selections = answer?.type === "multiple" ? answer.selections : [];
          const hasCustomSelection = selections.some((selection) => selection.isCustom);

          if (!hasCustomSelection) {
            openOtherInput();
            return;
          }

          const nextSelections = selections.filter((selection) => !selection.isCustom);
          if (nextSelections.length === 0) {
            answers.delete(question.id);
          } else {
            answers.set(question.id, {
              id: question.id,
              type: "multiple",
              selections: nextSelections,
            });
          }
          validationMessage = undefined;
          refresh();
        }

        function submit(cancelled: boolean): void {
          done({ questions, answers: orderedAnswers(), cancelled });
        }

        function handleInput(data: string): void {
          if (matchesKey(data, Key.ctrl("c"))) {
            submit(true);
            return;
          }

          if (otherInput) {
            if (matchesKey(data, Key.escape)) {
              otherInput = false;
              editor.setText("");
              validationMessage = undefined;
              refresh();
              return;
            }
            if (
              matchesKey(data, Key.enter) &&
              !matchesKey(data, Key.shift("enter"))
            ) {
              saveOtherAnswer();
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          const question = currentQuestion();

          if (matchesKey(data, Key.escape)) {
            submit(true);
            return;
          }

          if (matchesKey(data, Key.tab)) {
            goTo((currentIndex + 1) % (questions.length + 1));
            return;
          }
          if (matchesKey(data, Key.shift("tab"))) {
            goTo((currentIndex - 1 + questions.length + 1) % (questions.length + 1));
            return;
          }

          if (!question) {
            if (matchesKey(data, Key.enter)) {
              if (allComplete()) {
                submit(false);
              } else {
                setValidation("Answer all questions before you submit.");
              }
            }
            return;
          }

          if (question.type === "text") {
            if (
              matchesKey(data, Key.enter) &&
              !matchesKey(data, Key.shift("enter"))
            ) {
              if (saveTextAnswer()) {
                advance();
              }
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          const optionCount = question.options.length + (question.allowOther ? 1 : 0);
          if (matchesKey(data, Key.up)) {
            optionIndex = Math.max(0, optionIndex - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            optionIndex = Math.min(optionCount - 1, optionIndex + 1);
            refresh();
            return;
          }

          const isOther = question.allowOther && optionIndex === question.options.length;
          if (question.type === "single" && matchesKey(data, Key.enter)) {
            if (isOther) {
              openOtherInput();
            } else {
              const option = question.options[optionIndex];
              if (option) {
                chooseSingle(question, option);
              }
            }
            return;
          }

          if (question.type === "multiple" && matchesKey(data, Key.space)) {
            if (isOther) {
              toggleOtherMultiple(question);
            } else {
              const option = question.options[optionIndex];
              if (option) {
                toggleMultiple(question, option);
              }
            }
            return;
          }

          if (question.type === "multiple" && matchesKey(data, Key.enter)) {
            if (
              isOther &&
              !isComplete(question, answers.get(question.id)) &&
              !allowIncomplete
            ) {
              openOtherInput();
            } else if (
              isComplete(question, answers.get(question.id)) ||
              allowIncomplete
            ) {
              advance();
            } else {
              setValidation("Select at least one option before you continue.");
            }
          }
        }

        function render(width: number): string[] {
          if (cachedLines && cachedWidth === width) {
            return cachedLines;
          }

          const renderWidth = Math.max(1, width);
          const lines: string[] = [];
          const question = currentQuestion();

          function addWrapped(text: string): void {
            lines.push(...wrapTextWithAnsi(text, renderWidth));
          }

          function addWrappedWithPrefix(prefix: string, text: string): void {
            const prefixWidth = visibleWidth(prefix);
            if (prefixWidth >= renderWidth) {
              addWrapped(prefix + text);
              return;
            }

            const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
            const continuationPrefix = " ".repeat(prefixWidth);
            for (let index = 0; index < wrapped.length; index++) {
              lines.push(`${index === 0 ? prefix : continuationPrefix}${wrapped[index]}`);
            }
          }

          lines.push(theme.fg("accent", "─".repeat(renderWidth)));

          const tabs = questions.map((item, index) => {
            const complete = isComplete(item, answers.get(item.id));
            const marker = complete ? "■" : "□";
            const text = ` ${marker} ${item.label} `;
            if (index === currentIndex) {
              return theme.bg("selectedBg", theme.fg("text", text));
            }
            return theme.fg(complete ? "success" : "muted", text);
          });
          const submitText = " ✓ Submit ";
          tabs.push(
            currentIndex === questions.length
              ? theme.bg("selectedBg", theme.fg("text", submitText))
              : theme.fg(allComplete() ? "success" : "dim", submitText),
          );
          addWrappedWithPrefix(" ", tabs.join(" "));
          lines.push("");

          if (!question) {
            addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Review answers")));
            lines.push("");
            for (const item of questions) {
              const answer = answers.get(item.id);
              if (answer) {
                addWrappedWithPrefix(
                  " ",
                  `${theme.fg("muted", `${item.label}: `)}${theme.fg("text", getAnswerLabel(answer))}`,
                );
              } else {
                addWrappedWithPrefix(
                  " ",
                  `${theme.fg("muted", `${item.label}: `)}${theme.fg("warning", "Not answered")}`,
                );
              }
            }
            lines.push("");
            addWrappedWithPrefix(
              " ",
              allComplete()
                ? theme.fg("success", "Press Enter to submit")
                : theme.fg("warning", "Answer all questions before you submit"),
            );
          } else {
            addWrappedWithPrefix(
              " ",
              theme.fg("text", theme.bold(`${question.label}: ${question.prompt}`)),
            );
            lines.push("");

            if (question.type === "text" || otherInput) {
              if (otherInput) {
                addWrappedWithPrefix(" ", theme.fg("muted", "Different answer:"));
              }
              for (const editorLine of editor.render(Math.max(1, renderWidth - 2))) {
                lines.push(` ${editorLine}`);
              }
            } else {
              const answer = answers.get(question.id);
              for (let index = 0; index < question.options.length; index++) {
                const option = question.options[index];
                const active = index === optionIndex;
                const checked =
                  answer?.type === "single"
                    ? !answer.selection.isCustom && answer.selection.value === option.value
                    : answer?.type === "multiple"
                      ? answer.selections.some(
                          (selection) =>
                            !selection.isCustom && selection.value === option.value,
                        )
                      : false;
                const marker =
                  question.type === "multiple" ? `[${checked ? "x" : " "}]` : checked ? "●" : "○";
                const prefix = active ? theme.fg("accent", "> ") : "  ";
                const color = active ? "accent" : "text";
                addWrappedWithPrefix(
                  prefix,
                  theme.fg(color, `${marker} ${option.label}`),
                );
                if (option.description) {
                  addWrappedWithPrefix("      ", theme.fg("muted", option.description));
                }
              }

              if (question.allowOther) {
                const active = optionIndex === question.options.length;
                const customSelection =
                  answer?.type === "single"
                    ? answer.selection.isCustom
                      ? answer.selection
                      : undefined
                    : answer?.type === "multiple"
                      ? answer.selections.find((selection) => selection.isCustom)
                      : undefined;
                const checked = customSelection !== undefined;
                const marker =
                  question.type === "multiple" ? `[${checked ? "x" : " "}]` : checked ? "●" : "○";
                const label = customSelection
                  ? `Different answer: ${customSelection.label}`
                  : "Different answer…";
                addWrappedWithPrefix(
                  active ? theme.fg("accent", "> ") : "  ",
                  theme.fg(active ? "accent" : "text", `${marker} ${label}`),
                );
              }
            }
          }

          if (validationMessage) {
            lines.push("");
            addWrappedWithPrefix(" ", theme.fg("warning", validationMessage));
          }

          lines.push("");
          let help = "Tab/Shift+Tab navigate • Esc cancel";
          if (otherInput || question?.type === "text") {
            help = `Enter continue • Shift+Enter newline • ${help}`;
          } else if (question?.type === "multiple") {
            help = `↑↓ move • Space toggle • Enter continue • ${help}`;
          } else if (question?.type === "single") {
            help = `↑↓ move • Enter select • ${help}`;
          } else {
            help = `Enter submit • ${help}`;
          }
          addWrappedWithPrefix(" ", theme.fg("dim", help));
          lines.push(theme.fg("accent", "─".repeat(renderWidth)));

          cachedWidth = width;
          cachedLines = lines.map((line) => truncateToWidth(line, renderWidth, ""));
          return cachedLines;
        }

        let focused = false;
        const component: Component & Focusable = {
          get focused() {
            return focused;
          },
          set focused(value: boolean) {
            focused = value;
            editor.focused = value;
          },
          render,
          handleInput,
          invalidate() {
            cachedWidth = undefined;
            cachedLines = undefined;
            editor.invalidate();
          },
        };

        loadEditorForCurrentQuestion();
        return component;
      });
  }

  pi.registerTool({
    name: "question",
    label: "Question",
    description:
      "Ask the user one or more structured questions. Supports single choice, multiple choice, free text, and an optional custom answer for choice questions.",
    promptSnippet: "Ask the user structured single-choice, multiple-choice, or free-text questions",
    promptGuidelines: [
      "Use question when you need user judgment, preferences, or missing requirements before you can continue.",
      "Use question to ask related questions together, but do not ask for facts you can inspect or infer safely.",
    ],
    parameters: QuestionParamsSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const questions = normalizeQuestions(params);
      const result = await presentQuestions(questions, ctx);

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the questionnaire." }],
          details: result,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: result.answers
              .map((answer) => {
                const question = questions.find((item) => item.id === answer.id);
                return question ? summarizeAnswer(question, answer) : undefined;
              })
              .filter((line): line is string => line !== undefined)
              .join("\n"),
          },
        ],
        details: result,
      };
    },

    renderCall(args, theme) {
      const count = args.questions.length;
      const labels = args.questions.map((question) => question.label || question.id);
      let text = theme.fg("toolTitle", theme.bold("question "));
      text += theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
      if (labels.length > 0) {
        text += theme.fg("dim", ` (${labels.join(", ")})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as QuestionDetails | undefined;
      if (!details) {
        const content = result.content[0];
        return new Text(content?.type === "text" ? content.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }

      const lines = details.answers.map((answer) => {
        const question = details.questions.find((item) => item.id === answer.id);
        const label = question?.label ?? answer.id;
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", `${label}: `)}${getAnswerLabel(answer)}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerCommand("answer", {
    description: "Extract questions from the last assistant message and answer them",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/answer requires interactive TUI mode", "error");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }
      if (!ctx.modelRegistry) {
        ctx.ui.notify("Model registry not available", "error");
        return;
      }

      let lastAssistantText: string | undefined;
      let assistantMessagesChecked = 0;
      const branch = ctx.sessionManager.getBranch();

      for (let index = branch.length - 1; index >= 0; index--) {
        const entry = branch[index];
        if (entry.type !== "message" || entry.message.role !== "assistant") {
          continue;
        }

        assistantMessagesChecked++;
        if (
          entry.message.stopReason !== "stop" &&
          entry.message.stopReason !== "toolUse"
        ) {
          ctx.ui.notify(
            `Last assistant message is incomplete (${entry.message.stopReason})`,
            "error",
          );
          return;
        }

        const text = entry.message.content
          .filter(
            (content): content is { type: "text"; text: string } =>
              content.type === "text",
          )
          .map((content) => content.text)
          .join("\n")
          .trim();
        if (text.length > 0) {
          lastAssistantText = text;
          break;
        }
      }

      if (!lastAssistantText) {
        ctx.ui.notify(
          assistantMessagesChecked === 0
            ? "No assistant messages found"
            : "No questions found in the last assistant message",
          assistantMessagesChecked === 0 ? "error" : "info",
        );
        return;
      }

      const assistantText = lastAssistantText;
      const modelRegistry = ctx.modelRegistry;
      const extractionModel = await selectExtractionModel(ctx.model, modelRegistry);
      const extractionResult = await ctx.ui.custom<QuestionParams | null>(
        (tui, theme, _keybindings, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            `Extracting questions with ${extractionModel.id}...`,
          );
          loader.onAbort = () => done(null);

          const extract = async (): Promise<QuestionParams | null> => {
            const apiKey = await modelRegistry.getApiKeyForProvider(
              extractionModel.provider,
            );
            const userMessage: UserMessage = {
              role: "user",
              content: [{ type: "text", text: assistantText }],
              timestamp: Date.now(),
            };
            const response = await complete(
              extractionModel,
              { systemPrompt: EXTRACTION_SYSTEM_PROMPT, messages: [userMessage] },
              { apiKey, signal: loader.signal },
            );

            if (response.stopReason === "aborted") {
              return null;
            }

            const responseText = response.content
              .filter(
                (content): content is { type: "text"; text: string } =>
                  content.type === "text",
              )
              .map((content) => content.text)
              .join("\n");
            return parseExtractionResult(responseText);
          };

          extract().then(done).catch(() => done(null));
          return loader;
        },
      );

      if (extractionResult === null) {
        ctx.ui.notify("Question extraction was cancelled or failed", "info");
        return;
      }
      if (extractionResult.questions.length === 0) {
        ctx.ui.notify("No questions found in the last assistant message", "info");
        return;
      }

      const questions = normalizeQuestions(extractionResult).map((question) =>
        question.type === "text" ? question : { ...question, allowOther: true },
      );
      const result = await presentQuestions(questions, ctx, true);
      if (result.cancelled) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const answerText = questions
        .map((question) => {
          const answer = result.answers.find((item) => item.id === question.id);
          return answer
            ? summarizeAnswer(question, answer)
            : `${question.label} (${question.id}): no answer`;
        })
        .join("\n");

      pi.sendMessage(
        {
          customType: "answers",
          content: `I answered your questions in the following way:\n\n${answerText}`,
          display: true,
        },
        { triggerTurn: true },
      );
    },
  });
}
