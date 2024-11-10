import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { FileModule } from './file/file.module';
import { UserModule } from './user/user.module';
import { IdpModule } from './idp/idp.module';
import { TagModule } from './tag/tag.module';
import { NoticeModule } from './notice/notice.module';
import { DocumentModule } from './document/document.module';
import { ImageModule } from './image/image.module';
import { CrawlModule } from './crawl/crawl.module';
import { GroupModule } from './group/group.module';
import { FcmModule } from './fcm/fcm.module';
import { BullModule } from '@nestjs/bull';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from './ai/ai.module';
import { validate } from './env.validation';
import { CustomConfigService } from './config/customConfig.service';
import { CustomConfigModule } from './config/customConfig.module';

@Module({
  imports: [
    FileModule,
    UserModule,
    IdpModule,
    TagModule,
    NoticeModule,
    DocumentModule,
    ImageModule,
    CrawlModule,
    GroupModule,
    FcmModule,
    BullModule.forRootAsync({
      imports: [
        ConfigModule.forRoot({
          validate,
        }),
        CustomConfigModule,
      ],
      inject: [CustomConfigService],
      useFactory: (customConfigService: CustomConfigService) => ({
        redis: {
          host: customConfigService.REDIS_HOST,
          port: customConfigService.REDIS_PORT,
        },
      }),
    }),
    AiModule,
    CustomConfigModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
