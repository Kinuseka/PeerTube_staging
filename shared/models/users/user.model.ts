import { Account } from '../actors'
import { VideoChannel } from '../videos/channel/video-channel.model'
import { UserRole } from './user-role'
import { NSFWPolicyType } from '../videos/nsfw-policy.type'

export interface User {
  id: number
  username: string
  email: string
  emailVerified: boolean
  nsfwPolicy: NSFWPolicyType

  autoPlayVideo: boolean
  webTorrentEnabled: boolean
  videosHistoryEnabled: boolean

  role: UserRole
  videoQuota: number
  videoQuotaDaily: number
  createdAt: Date
  account: Account
  videoChannels?: VideoChannel[]

  blocked: boolean
  blockedReason?: string

  videoQuotaUsed?: number
}
