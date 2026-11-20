import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : typeof (exception as { status?: number }).status === 'number'
        ? (exception as { status: number }).status
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const detail = status >= 500 ? 'An unexpected error occurred' : exception instanceof Error ? exception.message : 'Unexpected error';
    const code = status >= 500 ? 'INTERNAL_ERROR' : typeof (exception as { code?: string }).code === 'string'
      ? (exception as { code: string }).code
      : 'INTERNAL_ERROR';
    if (status >= 500) {
      this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    }
    const headerRequestId = request.headers['x-request-id'];
    const requestId = typeof headerRequestId === 'string' && headerRequestId.trim()
      ? headerRequestId
      : crypto.randomUUID();

    response.setHeader('x-request-id', requestId);
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
