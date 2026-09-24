/** Files imported as text (`with { type: "text" }`): Bun inlines them, so a compiled CLI carries them. */
declare module "*.md" {
  const text: string;
  export default text;
}
