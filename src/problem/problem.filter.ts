import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { Request, Response } from 'express';
import { PROBLEM_JSON, toProblem } from './problem.util';

// Глобальний фільтр: будь-яка помилка -> application/problem+json (RFC 9457).
// Ловить і Nest-винятки з сервісів (404/422), і помилки
// express-openapi-validator (клас BadRequest тощо з числовим .status),
// які Nest пропускає у свій exception-layer.
@Catch()
export class ProblemJsonFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = 500;
    let detail = 'Unexpected error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        detail = body;
      } else if (body && typeof body === 'object') {
        const msg = (body as Record<string, unknown>).message;
        detail = Array.isArray(msg) ? msg.join('; ') : String(msg ?? exception.message);
      }
    } else if (isHttpLikeError(exception)) {
      // помилки express-openapi-validator: request/response validation
      status = exception.status ?? exception.statusCode ?? 500;
      detail = exception.message ?? detail;
    } else if (exception instanceof Error) {
      detail = exception.message;
    }

    const problem = toProblem(status, detail, req.originalUrl);
    res.status(status).setHeader('Content-Type', PROBLEM_JSON);
    // .send (не .json), щоб не тригерити повторну валідацію відповіді валідатором
    res.send(JSON.stringify(problem));
  }
}

interface HttpLikeError {
  status?: number;
  statusCode?: number;
  message?: string;
}

function isHttpLikeError(e: unknown): e is HttpLikeError {
  return (
    typeof e === 'object' &&
    e !== null &&
    (typeof (e as HttpLikeError).status === 'number' ||
      typeof (e as HttpLikeError).statusCode === 'number')
  );
}
