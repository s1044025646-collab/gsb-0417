export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "LIMIT_EXCEEDED"
  | "CONFLICT"
  | "INTERNAL";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public httpStatus: number = 400
  ) {
    super(message);
  }
}

export const MAX_SAMPLES = 100000;
export const MAX_DISPLAY = 500;

export function validateValues(input: unknown): number[] {
  if (!Array.isArray(input)) {
    throw new ApiError("INVALID_INPUT", "values 必须是整数数组");
  }
  if (input.length > MAX_SAMPLES) {
    throw new ApiError("LIMIT_EXCEEDED", `采样点数超过上限 ${MAX_SAMPLES}`, 413);
  }
  for (let i = 0; i < input.length; i++) {
    const v = input[i];
    if (typeof v !== "number" || !Number.isSafeInteger(v)) {
      throw new ApiError(
        "INVALID_INPUT",
        `第 ${i} 个采样不是安全整数: ${JSON.stringify(v)}`
      );
    }
  }
  return input as number[];
}
