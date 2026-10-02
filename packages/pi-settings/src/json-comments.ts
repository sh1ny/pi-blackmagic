/** Remove JSON comments without interpreting strings, credentials, URLs, or commands. */
export function stripJsonComments(source: string): string {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index] as string;
    if (quoted) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
      output += character;
    } else if (character === "/" && source[index + 1] === "/") {
      output += "  ";
      index += 2;
      while (
        index < source.length &&
        source[index] !== "\n" &&
        source[index] !== "\r"
      ) {
        output += " ";
        index++;
      }
      if (index < source.length) output += source[index];
    } else if (character === "/" && source[index + 1] === "*") {
      output += "  ";
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        output +=
          source[index] === "\n" || source[index] === "\r"
            ? source[index]
            : " ";
        index++;
      }
      if (index >= source.length) throw new Error("Unterminated JSON comment.");
      output += "  ";
      index++;
    } else output += character;
  }
  return output;
}
