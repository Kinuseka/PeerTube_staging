import { move } from 'fs-extra'
import { join } from 'path'
import { logger } from '@server/helpers/logger'
import { DIRECTORIES } from '@server/initializers/constants'
import { MVideo, MVideoFile, MVideoFullLight } from '@server/types/models'
import { VideoPrivacy, VideoStorage } from '@shared/models'
import { updateHLSFilesACL, updateHLSFilesPolicy, updateWebTorrentFileACL, updateWebTorrentFilePolicy } from './object-storage'
import { ACLEnabled, PolicyEnabled } from './object-storage/shared'

function setVideoPrivacy (video: MVideo, newPrivacy: VideoPrivacy) {
  if (video.privacy === VideoPrivacy.PRIVATE && newPrivacy !== VideoPrivacy.PRIVATE) {
    video.publishedAt = new Date()
  }

  video.privacy = newPrivacy
}

function isVideoInPrivateDirectory (privacy: VideoPrivacy) {
  return privacy === VideoPrivacy.PRIVATE || privacy === VideoPrivacy.INTERNAL
}

function isVideoInPublicDirectory (privacy: VideoPrivacy) {
  return !isVideoInPrivateDirectory(privacy)
}

async function moveFilesIfPrivacyChanged (video: MVideoFullLight, oldPrivacy: VideoPrivacy) {
  // Now public, previously private
  if (isVideoInPublicDirectory(video.privacy) && isVideoInPrivateDirectory(oldPrivacy)) {
    await moveFiles({ type: 'private-to-public', video })

    return true
  }

  // Now private, previously public
  if (isVideoInPrivateDirectory(video.privacy) && isVideoInPublicDirectory(oldPrivacy)) {
    await moveFiles({ type: 'public-to-private', video })

    return true
  }

  return false
}

export {
  setVideoPrivacy,

  isVideoInPrivateDirectory,
  isVideoInPublicDirectory,

  moveFilesIfPrivacyChanged
}

// ---------------------------------------------------------------------------

type MoveType = 'private-to-public' | 'public-to-private'

async function moveFiles (options: {
  type: MoveType
  video: MVideoFullLight
}) {
  const { type, video } = options
  const isACLon = ACLEnabled()


  for (const file of video.VideoFiles) {
    if (file.storage === VideoStorage.FILE_SYSTEM) {
      await moveWebTorrentFileOnFS(type, video, file)
    } else {
      if (isACLon){
        await updateWebTorrentFileACL(video, file)
      } else if (PolicyEnabled()) {
        await updateWebTorrentFilePolicy(video, file)
      }
    }
  }

  const hls = video.getHLSPlaylist()

  if (hls) {
    if (hls.storage === VideoStorage.FILE_SYSTEM) {
      await moveHLSFilesOnFS(type, video)
    } else {
      if (isACLon){
        await updateHLSFilesACL(hls)
      } else if (PolicyEnabled()){
        await updateHLSFilesPolicy(hls)
      }
    }
  }
}

async function moveWebTorrentFileOnFS (type: MoveType, video: MVideo, file: MVideoFile) {
  const directories = getWebTorrentDirectories(type)

  const source = join(directories.old, file.filename)
  const destination = join(directories.new, file.filename)

  try {
    logger.info('Moving WebTorrent files of %s after privacy change (%s -> %s).', video.uuid, source, destination)

    await move(source, destination)
  } catch (err) {
    logger.error('Cannot move webtorrent file %s to %s after privacy change', source, destination, { err })
  }
}

function getWebTorrentDirectories (moveType: MoveType) {
  if (moveType === 'private-to-public') {
    return { old: DIRECTORIES.VIDEOS.PRIVATE, new: DIRECTORIES.VIDEOS.PUBLIC }
  }

  return { old: DIRECTORIES.VIDEOS.PUBLIC, new: DIRECTORIES.VIDEOS.PRIVATE }
}

// ---------------------------------------------------------------------------

async function moveHLSFilesOnFS (type: MoveType, video: MVideo) {
  const directories = getHLSDirectories(type)

  const source = join(directories.old, video.uuid)
  const destination = join(directories.new, video.uuid)

  try {
    logger.info('Moving HLS files of %s after privacy change (%s -> %s).', video.uuid, source, destination)

    await move(source, destination)
  } catch (err) {
    logger.error('Cannot move HLS file %s to %s after privacy change', source, destination, { err })
  }
}

function getHLSDirectories (moveType: MoveType) {
  if (moveType === 'private-to-public') {
    return { old: DIRECTORIES.HLS_STREAMING_PLAYLIST.PRIVATE, new: DIRECTORIES.HLS_STREAMING_PLAYLIST.PUBLIC }
  }

  return { old: DIRECTORIES.HLS_STREAMING_PLAYLIST.PUBLIC, new: DIRECTORIES.HLS_STREAMING_PLAYLIST.PRIVATE }
}
