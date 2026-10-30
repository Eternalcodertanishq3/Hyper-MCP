import type { IndexedTool } from "../config/types.ts";

function tokens(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9_]+/g) ?? []).map((term) => {
    if (term.length > 5 && term.endsWith("ies")) return term.slice(0, -3) + "y";
    if (term.length > 4 && term.endsWith("s") && !term.endsWith("ss") && !term.endsWith("us")) return term.slice(0, -1);
    return term;
  });
}

function parameterNames(schema: Record<string, unknown>): string[] {
  const props = schema.properties;
  return props && typeof props === "object" ? Object.keys(props as object) : [];
}

export class ToolRouter {
  private tools: IndexedTool[] = [];

  replaceTools(tools: IndexedTool[]): void {
    this.tools = [...tools];
  }

  list(): IndexedTool[] {
    return [...this.tools];
  }

  search(query: string, limit = 5): Array<IndexedTool & { score: number }> {
    const queryTerms = tokens(query);
    if (!queryTerms.length) return [];
    const corpus = this.tools.map((tool) => {
      const fields = [
        { text: tool.server, weight: 2.5 },
        { text: tool.name.replaceAll("_", " "), weight: 3 },
        { text: tool.description, weight: 1 },
        { text: parameterNames(tool.inputSchema).join(" "), weight: 1.5 },
      ];
      const weightedTokens = fields.flatMap(({ text, weight }) => tokens(text).map((term) => ({ term, weight })));
      return { tool, weightedTokens, length: weightedTokens.reduce((n, item) => n + item.weight, 0) };
    });
    const averageLength = corpus.reduce((sum, item) => sum + item.length, 0) / Math.max(corpus.length, 1);
    return corpus.map(({ tool, weightedTokens, length }) => {
      let score = 0;
      for (const term of queryTerms) {
        const documentFrequency = corpus.filter((item) => item.weightedTokens.some((token) => token.term === term)).length;
        if (!documentFrequency) continue;
        const termFrequency = weightedTokens.filter((token) => token.term === term).reduce((sum, token) => sum + token.weight, 0);
        const idf = Math.log(1 + (corpus.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
        const k1 = 1.2;
        const b = 0.75;
        score += idf * ((termFrequency * (k1 + 1)) / (termFrequency + k1 * (1 - b + b * length / (averageLength || 1))));
      }
      return { ...tool, score };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
  }
}
