import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';
import { SkipCsrf } from '../auth/decorators/skip-csrf.decorator';
import { ContactLeadService } from './contact-lead.service';
import { SubmitContactDto } from './dto/submit-contact.dto';
import { PUBLIC_CONTACT_THROTTLE } from './public-contact.constants';

/**
 * The marketing site's Contact Us form (CR-05). Anonymous by nature: the visitor is a prospect with
 * no account. `@SkipCsrf` because a signed-in staff member with a stale auth cookie must still be
 * able to submit it; the route reads no session and changes nothing but a new lead row.
 */
@ApiTags('Public - Contact')
@Controller('public/contact')
export class PublicContactController {
  constructor(private readonly leads: ContactLeadService) {}

  @Public()
  @SkipCsrf()
  @Throttle(PUBLIC_CONTACT_THROTTLE)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a Contact Us enquiry (anonymous)' })
  async submit(@Body() dto: SubmitContactDto): Promise<{ received: true }> {
    await this.leads.submit(dto);
    return { received: true };
  }
}
