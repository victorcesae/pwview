// Completing file names in the chat box. Kept free of UI components so it can be unit-tested in Node.

/** What is being completed when the text ends in @something; undefined otherwise. */
export function atQuery(text: string): string | undefined {
  // the box gives Markdown, where typing my_file arrives as my\_file
  return /(?:^|\s)@([^\s@`]*)$/.exec(text)?.[1].replace(/\\/g, '');
}

/** The text with the final @something replaced by the path, as code so Markdown leaves it alone (__init__.py). */
export const withFile = (text: string, file: string) => text.replace(/@[^\s@`]*$/, () => `\`${file}\` `);

/** The command when the message starts with !; undefined otherwise (also for a bare !). */
export function shellCommand(plainText: string): string | undefined {
  return /^!\s*([\s\S]*\S)\s*$/.exec(plainText)?.[1];
}
