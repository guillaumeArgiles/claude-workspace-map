import { describe, expect, it } from "vitest";
import { stripAnsi, VoiceTextFilter } from "./voiceTextFilter";

describe("stripAnsi", () => {
  it("removes CSI cursor & colour sequences", () => {
    const ansi = "\x1b[31mhello\x1b[0m \x1b[2Jworld\x1b[H";
    expect(stripAnsi(ansi)).toBe("hello world");
  });

  it("removes OSC title-set sequences (ESC ]...BEL)", () => {
    const ansi = "before\x1b]0;title here\x07after";
    expect(stripAnsi(ansi)).toBe("beforeafter");
  });

  it("removes lone BEL / BS / FF control bytes", () => {
    expect(stripAnsi("a\x07b\x08c\x0cd")).toBe("abcd");
  });

  it("keeps newlines and tabs intact", () => {
    expect(stripAnsi("line one\nline two\ttab")).toBe("line one\nline two\ttab");
  });
});

describe("VoiceTextFilter", () => {
  it("returns prose lines unchanged", () => {
    const f = new VoiceTextFilter();
    expect(f.feed("Bonjour utilisateur.\n")).toBe("Bonjour utilisateur.");
  });

  it("waits for newline before emitting a partial line", () => {
    const f = new VoiceTextFilter();
    expect(f.feed("Salut, je su")).toBe("");
    expect(f.feed("is le Professeur.\n")).toBe("Salut, je suis le Professeur.");
  });

  it("strips code-fenced blocks across multiple feeds", () => {
    const f = new VoiceTextFilter();
    expect(f.feed("Voici la prose.\n")).toBe("Voici la prose.");
    expect(f.feed("```javascript\nconst x = 42;\n")).toBe("");
    expect(f.feed("```\nEt voici la suite.\n")).toBe("Et voici la suite.");
  });

  it("drops standalone file-path lines", () => {
    const f = new VoiceTextFilter();
    expect(f.feed("/Users/foo/bar.json\n")).toBe("");
    expect(f.feed("~/.claude/config.json\n")).toBe("");
    expect(f.feed("./src/index.ts\n")).toBe("");
  });

  it("drops box-drawing / separator chrome lines", () => {
    const f = new VoiceTextFilter();
    expect(f.feed("─────────────────\n")).toBe("");
    expect(f.feed("┌────┐\n│ ok │\n└────┘\n")).toBe("ok");
  });

  it("drops tool-call marker lines (⏺ list_agents()  …)", () => {
    const f = new VoiceTextFilter();
    expect(f.feed("⏺ list_agents()\n")).toBe("");
    expect(f.feed("● Read /some/file.txt\n")).toBe("");
  });

  it("drops bare URL lines but keeps prose mentioning URLs", () => {
    const f = new VoiceTextFilter();
    expect(f.feed("https://anthropic.com/docs\n")).toBe("");
    expect(f.feed("Va voir https://anthropic.com pour plus d'infos.\n"))
      .toBe("Va voir https://anthropic.com pour plus d'infos.");
  });

  it("strips ANSI before line-level processing", () => {
    const f = new VoiceTextFilter();
    expect(f.feed("\x1b[31mBonjour\x1b[0m utilisateur.\n"))
      .toBe("Bonjour utilisateur.");
  });

  it("joins multiple speakable lines from one feed with spaces", () => {
    const f = new VoiceTextFilter();
    expect(f.feed("Bonjour.\nComment vas-tu ?\n")).toBe("Bonjour. Comment vas-tu ?");
  });

  it("reset() clears pending buffer and code-block state", () => {
    const f = new VoiceTextFilter();
    f.feed("```\nconst x = 1;\n");
    f.reset();
    expect(f.feed("Texte propre.\n")).toBe("Texte propre.");
  });
});
