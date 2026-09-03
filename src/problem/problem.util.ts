// Єдиний конструктор тіла помилки за RFC 9457 (application/problem+json).

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

export const PROBLEM_JSON = 'application/problem+json';

export function toProblem(status: number, detail: string, instance: string): Problem {
  return {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    detail,
    instance,
  };
}
