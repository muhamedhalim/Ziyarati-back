import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ContactLead } from '../../entities/Sales/ContactLead';
import { ContactLeadService } from './contact-lead.service';
import { PlatformContactLeadsController } from './platform-contact-leads.controller';
import { PublicContactController } from './public-contact.controller';

/** Contact Us enquiries from the public marketing site (CR-05). EmailModule is global. */
@Module({
  imports: [TypeOrmModule.forFeature([ContactLead])],
  controllers: [PublicContactController, PlatformContactLeadsController],
  providers: [ContactLeadService],
})
export class PublicContactModule {}
