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

  it("drops Claude Code's boot banner (block-element art + meta lines)", () => {
    const f = new VoiceTextFilter();
    const banner =
      "▐▛███▜▌   Claude Code v2.1.158\n" +
      "▝▜█████▛▘  Sonnet 4.6 · Claude Team\n" +
      "  ▘▘ ▝▝    ~/.claude-workspace-map/professor\n";
    expect(f.feed(banner)).toBe("");
  });

  it("drops 'Sonnet 4.6 · Claude Team' style meta lines", () => {
    const f = new VoiceTextFilter();
    expect(f.feed("Sonnet 4.6 · Claude Team\n")).toBe("");
    expect(f.feed("Opus 4.7 · Claude Max\n")).toBe("");
    expect(f.feed("Haiku 4.5 · Claude Free\n")).toBe("");
  });

  it("drops bare home-dir paths from the banner", () => {
    const f = new VoiceTextFilter();
    expect(f.feed("~/.claude-workspace-map/professor\n")).toBe("");
    expect(f.feed("/Users/foo/projects/bar\n")).toBe("");
  });

  it("keeps prose that mentions Claude inline", () => {
    const f = new VoiceTextFilter();
    // The "Claude Code v" rule should only fire when the line is meta —
    // a prose sentence mentioning the name should still go through.
    expect(f.feed("Bienvenue dans ton espace de travail Claude.\n"))
      .toBe("Bienvenue dans ton espace de travail Claude.");
  });

  it("reset() clears pending buffer and code-block state", () => {
    const f = new VoiceTextFilter();
    f.feed("```\nconst x = 1;\n");
    f.reset();
    expect(f.feed("Texte propre.\n")).toBe("Texte propre.");
  });
});
