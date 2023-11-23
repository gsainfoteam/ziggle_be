import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import cheerio from 'cheerio';
import dayjs from 'dayjs';
import { htmlToText } from 'html-to-text';
import {
  catchError,
  firstValueFrom,
  from,
  map,
  takeWhile,
  throwError,
  timeout,
  toArray,
} from 'rxjs';
import { FcmService } from 'src/global/service/fcm.service';
import { ImageService } from 'src/image/image.service';
import { TagService } from 'src/tag/tag.service';
import { UserService } from 'src/user/user.service';
import { AdditionalNoticeDto } from './dto/additionalNotice.dto';
import { CreateNoticeDto } from './dto/createNotice.dto';
import { ForeignContentDto } from './dto/foreignContent.dto';
import { GetAllNoticeQueryDto } from './dto/getAllNotice.dto';
import { NoticeRepository } from './notice.repository';

@Injectable()
export class NoticeService {
  private readonly logger = new Logger(NoticeService.name);
  private readonly s3Url: string;
  constructor(
    private readonly noticeRepository: NoticeRepository,
    private readonly imageService: ImageService,
    private readonly fcmService: FcmService,
    private readonly httpService: HttpService,
    private readonly tagService: TagService,
    private readonly userService: UserService,
    configService: ConfigService,
  ) {
    this.s3Url = `https://s3.${configService.get<string>(
      'AWS_S3_REGION',
    )}.amazonaws.com/${configService.get<string>('AWS_S3_BUCKET_NAME')}/`;
  }

  async getNoticeList(
    getAllNoticeQueryDto: GetAllNoticeQueryDto,
    userUuid?: string,
  ) {
    const notices = await this.noticeRepository.getNoticeList(
      getAllNoticeQueryDto,
      userUuid,
    );
    return {
      total: await this.noticeRepository.getTotalCount(
        getAllNoticeQueryDto,
        userUuid,
      ),
      list: notices.map(({ files, author, ...notice }) => {
        delete notice.authorId;
        return {
          ...notice,
          contents: notice.contents.map((content) => ({
            ...content,
            body: htmlToText(content.body).slice(0, 100),
          })),
          author: author.name,
          imageUrl: files?.[0]?.url ? `${this.s3Url}${files[0].url}` : null,
          title: notice.contents[0].title,
          body: htmlToText(notice.contents[0].body).slice(0, 100),
        };
      }),
    };
  }

  async getNotice(id: number, userUuid?: string) {
    const notice = await this.noticeRepository.getNotice(id);
    const { reminders, ...noticeInfo } = notice;
    return {
      ...noticeInfo,
      author: notice.author.name,
      imagesUrl: notice.files?.map((file) => `${this.s3Url}${file.url}`),
      reminder: reminders.some((reminder) => reminder.uuid === userUuid),
      title: notice.contents[0].title,
      body: htmlToText(notice.contents[0].body),
    };
  }

  async createNotice(
    { title, body, deadline, tags, images }: CreateNoticeDto,
    userUuid: string,
  ) {
    if (images.length) {
      await this.imageService.validateImages(images);
    }

    const notice = await this.noticeRepository.createNotice(
      {
        title,
        body,
        deadline,
        tags,
        images,
      },
      userUuid,
    );

    this.fcmService.postMessage(
      {
        title: '새 공지글',
        body: title,
        imageUrl:
          !images || images.length === 0
            ? undefined
            : `${this.s3Url}${images[0]}`,
      },
      (await this.noticeRepository.getAllFcmTokens()).map(({ token }) => token),
      { path: `/root/article?id=${notice.id}` },
    );
    return this.getNotice(notice.id);
  }

  async addNoticeAdditional(
    { title, body, deadline, to }: AdditionalNoticeDto,
    id: number,
    userUuid: string,
  ) {
    await this.noticeRepository.addAdditionalNotice(
      {
        title,
        body,
        deadline,
      },
      id,
      userUuid,
    );
    if (to) {
      this.fcmService.postMessage(
        {
          title: '공지글이 추가되었습니다.',
          body: title,
        },
        to === 'all'
          ? (await this.noticeRepository.getAllFcmTokens()).map(
              ({ token }) => token,
            )
          : (await this.noticeRepository.getFcmTokensByNoticeId(id)).map(
              ({ token }) => token,
            ),
        { path: `/root/article?id=${id}` },
      );
    }

    return this.getNotice(id);
  }

  async addForeignContent(
    { lang, title, body, deadline }: ForeignContentDto,
    id: number,
    idx: number,
    userUuid: string,
  ) {
    await this.noticeRepository.addForeignContent(
      { lang, title, body, deadline },
      id,
      idx,
      userUuid,
    );
    return this.getNotice(id);
  }

  async addNoticeReminder(id: number, userUuid: string) {
    await this.noticeRepository.addReminder(id, userUuid);

    return this.getNotice(id, userUuid);
  }

  async removeNoticeReminder(id: number, userUuid: string) {
    await this.noticeRepository.removeReminder(id, userUuid);

    return this.getNotice(id, userUuid);
  }

  async deleteNotice(id: number, userUuid: string): Promise<void> {
    const notice = await this.noticeRepository.getNotice(id);
    this.imageService.deleteImages(notice.files.map(({ url }) => url));
    await this.noticeRepository.deleteNotice(id, userUuid);
  }

  @Cron('0 9 * * *')
  async sendReminderMessage() {
    const targetNotices = await this.noticeRepository.getNoticeByTime(
      new Date(),
    );
    targetNotices.map((notice) => {
      const leftDate = dayjs(notice.currentDeadline)
        .startOf('d')
        .diff(dayjs().startOf('d'), 'd');
      return this.fcmService.postMessage(
        {
          title: `[Reminder] ${leftDate}일 남은 공지가 있어요!`,
          body: `${notice.contents[0].title} 마감이 ${leftDate}일 남았어요`,
          imageUrl: notice.files?.[0].url
            ? `${this.s3Url}${notice.files[0].url}`
            : undefined,
        },
        notice.reminders
          .flatMap(({ fcmTokens }) => fcmTokens)
          .map(({ token }) => token),
        { path: `/root/article?id=${notice.id}` },
      );
    });
  }

  private async getAcademicNoticeList() {
    const baseUrl = 'https://www.gist.ac.kr/kr/html/sub05/050209.html';
    const stream = this.httpService.get(baseUrl).pipe(
      timeout(10000),
      map((res) => res.data),
      map((e) => cheerio.load(e)),
      catchError(throwError),
    );
    const $ = await firstValueFrom(stream);
    const notices = $('table > tbody > tr')
      .filter((_, e) => e.type === 'tag' && !e.attribs.class.includes('lstNtc'))
      .toArray()
      .map(
        (e) =>
          e.type === 'tag' && {
            id: Number.parseInt($(e).find('td').first().text().trim()),
            title: $(e).find('td').eq(2).text().trim(),
            link: `${baseUrl}${$(e).find('td').eq(2).find('a').attr('href')}`,
            author: $(e).find('td').eq(3).text().trim(),
            category: $(e).find('td').eq(1).text().trim(),
            createdAt: $(e).find('td').eq(5).text().trim(),
          },
      );
    return notices;
  }

  private async getAcademicNotice(link: string) {
    const baseUrl = 'https://www.gist.ac.kr/kr/html/sub05/050209.html';
    const stream = this.httpService.get(link).pipe(
      timeout(10000),
      map((res) => res.data),
      map((e) => cheerio.load(e)),
      catchError(throwError),
    );
    const $ = await firstValueFrom(stream);
    const files = $('.bd_detail_file > ul > li > a')
      .toArray()
      .map((e) => ({
        href: `${baseUrl}${$(e).attr('href')}`,
        name: $(e).text().trim(),
        type: $(e).attr('class') as
          | 'doc'
          | 'hwp'
          | 'pdf'
          | 'imgs'
          | 'xls'
          | 'etc',
      }));
    const content = $('.bd_detail_content').html().trim();
    return { files, content };
  }

  @Cron('0 */10 * * *')
  async crawlAcademicNotice() {
    this.logger.log('Academic Notice Crawling Start');
    const notices = await this.getAcademicNoticeList();
    this.logger.log(`Academic Notice Crawling End (${notices.length} notices)`);
    const recentNotice = await this.noticeRepository.getNoticeList({
      limit: 1,
      orderBy: 'recent',
      tags: ['academic'],
    });
    const noticesToCreate$ = from(notices).pipe(
      takeWhile((n) => n.title !== recentNotice[0].contents[0].title),
      toArray(),
      map((n) => n.reverse()),
    );
    const noticesToCreate = await firstValueFrom(noticesToCreate$);
    this.logger.log(
      `Academic Notice Creating (${noticesToCreate.length}) notices`,
    );
    for (const noticeMetadata of noticesToCreate) {
      const notice = await this.getAcademicNotice(noticeMetadata.link);
      this.logger.log(`Academic Notice Creating (${noticeMetadata.title})`);
      const filesList = notice.files
        .map((file) => `<li><a href="${file.href}">${file.name}</a></li>`)
        .join('');
      const filesBody = `<ul>${filesList}</ul>`;
      const body = `${notice.files.length ? filesBody : ''}${notice.content}`;
      const tags = await this.tagService.findOrCreateTags([
        'academic',
        noticeMetadata.category,
      ]);
      const user = await this.userService.addTempUser(
        `${noticeMetadata.author} (${noticeMetadata.category})`,
      );
      await this.noticeRepository.createNotice(
        {
          title: noticeMetadata.title,
          body,
          images: [],
          tags: tags.map(({ id }) => id),
        },
        user.uuid,
        dayjs(noticeMetadata.createdAt).tz('Asia/Seoul').toDate(),
      );
    }
  }
}
