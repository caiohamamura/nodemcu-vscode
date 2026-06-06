declare module "ini" {
  export function parse(input: string): Record<string, Record<string, unknown>>;
  export function stringify(obj: Record<string, unknown>, options?: { section?: string }): string;
}
