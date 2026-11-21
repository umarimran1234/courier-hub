import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`courier-hub listening on :${port}`);
  if (!process.env.ENCRYPTION_KEY) new Logger('Bootstrap').warn('ENCRYPTION_KEY is not set — using an insecure dev key. Set a random 64-hex-char key in production.');
}
bootstrap();
