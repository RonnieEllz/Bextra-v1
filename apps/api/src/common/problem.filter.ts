import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : typeof (exception as { status?: number }).status === 'number'
        ? (exception as { status: number }).status
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const detail = exception instanceof Error ? exception.message : 'Unexpected error';
    const code = typeof (exception as { code?: string }).code === 'string'
      ? (exception as { code: string }).code
      : 'INTERNAL_ERROR';
    const requestId = String(request.headers['x-request-id'] ?? crypto.randomUUID());

    response.status(status).json({
      type: 'about:blank',
      title: status === 500 ? 'Internal Server Error' : 'Request Error',
      status,
      detail,
      code,
      instance: request.originalUrl,
      requestId,
    });
  }
}
