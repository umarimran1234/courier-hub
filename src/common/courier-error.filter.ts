import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { CourierError, NotSupportedError } from '../couriers/courier.errors';

/** Turns adapter errors into clean HTTP responses instead of 500s. */
@Catch(CourierError)
export class CourierErrorFilter implements ExceptionFilter {
  private log = new Logger('CourierError');

  catch(err: CourierError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    let status = HttpStatus.UNPROCESSABLE_ENTITY; // courier refused the request (validation etc.)
    let code = 'COURIER_REJECTED';
    if (err instanceof NotSupportedError) {
      status = HttpStatus.NOT_IMPLEMENTED;
      code = 'NOT_SUPPORTED';
    } else if (err.opts.httpStatus === 401 || err.opts.httpStatus === 403 || /unauthorized/i.test(err.message)) {
      status = HttpStatus.BAD_GATEWAY;
      code = 'COURIER_AUTH_FAILED';
    } else if (err.retriable) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'COURIER_UNAVAILABLE';
    }
    this.log.warn(`${code}: ${err.message}`);
    res.status(status).json({ statusCode: status, code, courier: err.courier, message: err.message, retriable: err.retriable, details: err.opts.raw ?? undefined });
  }
}
