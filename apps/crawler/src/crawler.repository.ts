import { PrismaService } from '@lib/prisma';
import { Injectable } from '@nestjs/common';
import { Crawl, User } from '@prisma/client';

@Injectable()
export class CrawlerRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async checkCrawlData(urls: string[]): Promise<Crawl[]> {
    return this.prismaService.crawl.findMany({
      where: {
        url: {
          in: urls,
        },
      },
    });
  }

  async createCrawl(
    {
      title,
      body,
      type,
      crawledAt,
      url,
    }: Pick<Crawl, 'title' | 'body' | 'type' | 'crawledAt' | 'url'>,
    user: User,
    deadline?: Date,
  ): Promise<Crawl> {
    return this.prismaService.crawl.create({
      data: {
        title,
        body,
        type,
        url,
        crawledAt,
        notice: {
          create: {
            category: 'ACADEMIC',
            currentDeadline: deadline,
            author: {
              connect: user,
            },
            publishedAt: new Date(),
          },
        },
      },
    });
  }

  async updateCrawl(
    { title, body, type }: Pick<Crawl, 'title' | 'body' | 'type'>,
    id: number,
  ): Promise<Crawl> {
    return this.prismaService.crawl.update({
      where: {
        id,
      },
      data: {
        title,
        body,
        type,
      },
    });
  }
}