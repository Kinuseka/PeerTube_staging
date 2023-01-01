import { map } from 'bluebird'
import { createReadStream, createWriteStream, ensureDir, ReadStream } from 'fs-extra'
import { dirname } from 'path'
import { Readable } from 'stream'
import {
  _Object,
  CompleteMultipartUploadCommandOutput,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectAclCommand,
  GetBucketPolicyCommand,
  PutBucketPolicyCommand,
  PutObjectCommandInput,
  S3Client
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { pipelinePromise } from '@server/helpers/core-utils'
import { isArray } from '@server/helpers/custom-validators/misc'
import { logger } from '@server/helpers/logger'
import { CONFIG } from '@server/initializers/config'
import { getInternalUrl } from '../urls'
import { getClient } from './client'
import { lTags } from './logger'

type BucketInfo = {
  BUCKET_NAME: string
  PREFIX?: string
}

async function listKeysOfPrefix (prefix: string, bucketInfo: BucketInfo) {
  const s3Client = getClient()

  const commandPrefix = bucketInfo.PREFIX + prefix
  const listCommand = new ListObjectsV2Command({
    Bucket: bucketInfo.BUCKET_NAME,
    Prefix: commandPrefix
  })

  const listedObjects = await s3Client.send(listCommand)

  if (isArray(listedObjects.Contents) !== true) return []

  return listedObjects.Contents.map(c => c.Key)
}

// ---------------------------------------------------------------------------

async function storeObject (options: {
  inputPath: string
  objectStorageKey: string
  bucketInfo: BucketInfo
  isPrivate: boolean
}): Promise<string> {
  const { inputPath, objectStorageKey, bucketInfo, isPrivate } = options

  logger.debug('Uploading file %s to %s%s in bucket %s', inputPath, bucketInfo.PREFIX, objectStorageKey, bucketInfo.BUCKET_NAME, lTags())

  const fileStream = createReadStream(inputPath)

  return uploadToStorage({ objectStorageKey, content: fileStream, bucketInfo, isPrivate })
}

// ---------------------------------------------------------------------------

function updateObjectACL (options: {
  objectStorageKey: string
  bucketInfo: BucketInfo
  isPrivate: boolean
}) {
  const { objectStorageKey, bucketInfo, isPrivate } = options

  const key = buildKey(objectStorageKey, bucketInfo)

  logger.debug('Updating ACL file %s in bucket %s', key, bucketInfo.BUCKET_NAME, lTags())

  const command = new PutObjectAclCommand({
    Bucket: bucketInfo.BUCKET_NAME,
    Key: key,
    ACL: getACL(isPrivate)
  })

  return getClient().send(command)
}

function updatePrefixACL (options: {
  prefix: string
  bucketInfo: BucketInfo
  isPrivate: boolean
}) {
  const { prefix, bucketInfo, isPrivate } = options

  logger.debug('Updating ACL of files in prefix %s in bucket %s', prefix, bucketInfo.BUCKET_NAME, lTags())

  return applyOnPrefix({
    prefix,
    bucketInfo,
    commandBuilder: obj => {
      logger.debug('Updating ACL of %s inside prefix %s in bucket %s', obj.Key, prefix, bucketInfo.BUCKET_NAME, lTags())

      return new PutObjectAclCommand({
        Bucket: bucketInfo.BUCKET_NAME,
        Key: obj.Key,
        ACL: getACL(isPrivate)
      })
    }
  })
}
// ---------------------------------------------------------------------------

function PolicyTemplate() {
  return {
      "Version": "2012-10-17",
      "Statement": [
          {
              "Effect": "Allow",
              "Principal": {
                  "AWS": [
                      "*"
                  ]
              },
              "Action": [
                  "s3:GetObject"
              ],
              "Resource": [
                  "arn:aws:s3:::test/*"
              ]
          },
          {
              "Effect": "Deny",
              "Principal": {
                  "AWS": [
                      "*"
                  ]
              },
              "Action": [
                  "s3:GetObject"
              ],
              "Resource": [
                  ""
              ]
          }
      ]
  }
}

function createPolicy(options: {bucketInfo: BucketInfo}) {
  const { bucketInfo } = options
  const Policy = PolicyTemplate()
  const command = BucketpolicyUpdate({
    bucketInfo: bucketInfo,
    bucketPolicy: Policy
  })
  logger.debug('Policy is empty, attempting to create policy')
  return getClient().send(command)
}

function getbucketPolicy (options: {
  bucketInfo: BucketInfo
}) {
  const { bucketInfo } = options
  logger.debug('Fetching bucket policy of bucket %s', bucketInfo.BUCKET_NAME)
  const command = new GetBucketPolicyCommand({
      Bucket: bucketInfo.BUCKET_NAME
  })
  return getClient().send(command)
}
// -Lower level policy invocation
function BucketpolicyUpdate (options: {
  bucketInfo: BucketInfo
  bucketPolicy
}) {
  const { bucketInfo, bucketPolicy } = options
  const command = new PutBucketPolicyCommand({
    Bucket: bucketInfo.BUCKET_NAME,
    Policy: bucketPolicy
  })
  return command
}
// ----------------------------------------------------------
function addResource(options: {
  whichStatement: string,
  Key,
  bucketPolicy
}) {
  const { whichStatement, bucketPolicy } = options
  var statement = bucketPolicy.Statement
  if (whichStatement === "Deny") {
    statement[1].Resource.push()
  }
}

async function updateObjectBucketPolicy (options: {
  objectStorageKey: string
  bucketInfo: BucketInfo
  isPrivate: boolean
}) {
  
  const s3policyPrefix = "arn:aws:s3:::"
  const { objectStorageKey, bucketInfo, isPrivate } = options
  const key = buildKey(objectStorageKey, bucketInfo)

  logger.debug('Updating Bucket Policy for file %s in bucket %s', key, bucketInfo.BUCKET_NAME, lTags())

  var bucketPolicyResponse = await getbucketPolicy({bucketInfo: bucketInfo})
  
  if (!bucketPolicyResponse.Policy){
    await createPolicy({bucketInfo: bucketInfo})
    logger.debug('Reattempting to fetch bucket policy')
    bucketPolicyResponse = await getbucketPolicy({bucketInfo: bucketInfo}).Policy
    if (!bucketPolicyResponse.Policy) {
      throw new Error('Cannot fetch bucket policy')
    }
  }
  var bucketcollected = bucketPolicyResponse.Policy
  const command = new PutBucketPolicyCommand({
    Bucket: bucketInfo.BUCKET_NAME,
    Policy: addResource({
      whichStatement: getPolicy(isPrivate),
      Key: `${s3policyPrefix}${key}`,
      bucketPolicy: bucketcollected
    })
  })

  return getClient().send(command)
  }

async function updateObjectBucketPolicyPrefix (options: {
  prefix: string
  bucketInfo: BucketInfo
  isPrivate: boolean
}) {
  const { prefix, bucketInfo, isPrivate } = options
  const s3policyPrefix = "arn:aws:s3:::"
  var bucketPolicyResponse = await getbucketPolicy({bucketInfo: bucketInfo})
  
  if (!bucketPolicyResponse.Policy){
    await createPolicy({bucketInfo: bucketInfo})
    logger.debug('Reattempting to fetch bucket policy')
    bucketPolicyResponse = await getbucketPolicy({bucketInfo: bucketInfo}).Policy
    if (!bucketPolicyResponse.Policy) {
      throw new Error('Cannot fetch bucket policy')
    }
  }
  var bucketcollected = bucketPolicyResponse.Policy
  return applyOnPrefix({
    prefix,
    bucketInfo,
    commandBuilder: obj => {
      logger.debug('Updating Bucket policy of %s inside prefix %s in bucket %s', obj.Key, prefix, bucketInfo.BUCKET_NAME, lTags())
      return new PutBucketPolicyCommand({
        Bucket: bucketInfo.BUCKET_NAME,
        Policy: addResource({
          whichStatement: getPolicy(isPrivate),
          Key: `${s3policyPrefix}${obj.key}`,
          bucketPolicy: bucketcollected
        })
      })
    },
    isPolicymode: true
  })
}

// ---------------------------------------------------------------------------

function removeObject (objectStorageKey: string, bucketInfo: BucketInfo) {
  const key = buildKey(objectStorageKey, bucketInfo)

  return removeObjectByFullKey(key, bucketInfo)
}

function removeObjectByFullKey (fullKey: string, bucketInfo: BucketInfo) {
  logger.debug('Removing file %s in bucket %s', fullKey, bucketInfo.BUCKET_NAME, lTags())

  const command = new DeleteObjectCommand({
    Bucket: bucketInfo.BUCKET_NAME,
    Key: fullKey
  })

  return getClient().send(command)
}

async function removePrefix (prefix: string, bucketInfo: BucketInfo) {
  // FIXME: use bulk delete when s3ninja will support this operation

  logger.debug('Removing prefix %s in bucket %s', prefix, bucketInfo.BUCKET_NAME, lTags())

  return applyOnPrefix({
    prefix,
    bucketInfo,
    commandBuilder: obj => {
      logger.debug('Removing %s inside prefix %s in bucket %s', obj.Key, prefix, bucketInfo.BUCKET_NAME, lTags())

      return new DeleteObjectCommand({
        Bucket: bucketInfo.BUCKET_NAME,
        Key: obj.Key
      })
    }
  })
}

// ---------------------------------------------------------------------------

async function makeAvailable (options: {
  key: string
  destination: string
  bucketInfo: BucketInfo
}) {
  const { key, destination, bucketInfo } = options

  await ensureDir(dirname(options.destination))

  const command = new GetObjectCommand({
    Bucket: bucketInfo.BUCKET_NAME,
    Key: buildKey(key, bucketInfo)
  })
  const response = await getClient().send(command)

  const file = createWriteStream(destination)
  await pipelinePromise(response.Body as Readable, file)

  file.close()
}

function buildKey (key: string, bucketInfo: BucketInfo) {
  return bucketInfo.PREFIX + key
}

// ---------------------------------------------------------------------------

async function createObjectReadStream (options: {
  key: string
  bucketInfo: BucketInfo
  rangeHeader: string
}) {
  const { key, bucketInfo, rangeHeader } = options

  const command = new GetObjectCommand({
    Bucket: bucketInfo.BUCKET_NAME,
    Key: buildKey(key, bucketInfo),
    Range: rangeHeader
  })

  const response = await getClient().send(command)

  return {
    response,
    stream: response.Body as Readable
  }
}

// ---------------------------------------------------------------------------

export {
  BucketInfo,
  buildKey,

  storeObject,

  removeObject,
  removeObjectByFullKey,
  removePrefix,

  makeAvailable,

  updateObjectACL,
  updatePrefixACL,

  listKeysOfPrefix,
  createObjectReadStream,

  ACLEnabled,
  PolicyEnabled
}

// ---------------------------------------------------------------------------

async function uploadToStorage (options: {
  content: ReadStream
  objectStorageKey: string
  bucketInfo: BucketInfo
  isPrivate: boolean
}) {
  const { content, objectStorageKey, bucketInfo, isPrivate } = options
  
  if (ACLEnabled()){
    var input: PutObjectCommandInput = {
      Body: content,
      Bucket: bucketInfo.BUCKET_NAME,
      Key: buildKey(objectStorageKey, bucketInfo),
      ACL: getACL(isPrivate)
    }
  } else {
    var input: PutObjectCommandInput = {
      Body: content,
      Bucket: bucketInfo.BUCKET_NAME,
      Key: buildKey(objectStorageKey, bucketInfo)
    }
  }
  if(PolicyEnabled()) {
    updateObjectBucketPolicy({
      objectStorageKey: buildKey(objectStorageKey, bucketInfo),
      bucketInfo: bucketInfo,
      isPrivate: isPrivate
    })
  }

  const parallelUploads3 = new Upload({
    client: getClient(),
    queueSize: 4,
    partSize: CONFIG.OBJECT_STORAGE.MAX_UPLOAD_PART,

    // `leavePartsOnError` must be set to `true` to avoid silently dropping failed parts
    // More detailed explanation:
    // https://github.com/aws/aws-sdk-js-v3/blob/v3.164.0/lib/lib-storage/src/Upload.ts#L274
    // https://github.com/aws/aws-sdk-js-v3/issues/2311#issuecomment-939413928
    leavePartsOnError: true,
    params: input
  })

  const response = (await parallelUploads3.done()) as CompleteMultipartUploadCommandOutput
  // Check is needed even if the HTTP status code is 200 OK
  // For more information, see https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html
  if (!response.Bucket) {
    const message = `Error uploading ${objectStorageKey} to bucket ${bucketInfo.BUCKET_NAME}`
    logger.error(message, { response, ...lTags() })
    throw new Error(message)
  }

  logger.debug(
    'Completed %s%s in bucket %s',
    bucketInfo.PREFIX, objectStorageKey, bucketInfo.BUCKET_NAME, lTags()
  )
  
  return getInternalUrl(bucketInfo, objectStorageKey)
}

async function applyOnPrefix (options: {
  prefix: string
  bucketInfo: BucketInfo
  commandBuilder?: (obj: _Object) => Parameters<S3Client['send']>[0]
  

  continuationToken?: string
  isPolicymode?: boolean
}) {
  const { prefix, bucketInfo, commandBuilder, continuationToken, isPolicymode } = options

  const s3Client = getClient()

  const commandPrefix = buildKey(prefix, bucketInfo)
  const listCommand = new ListObjectsV2Command({
    Bucket: bucketInfo.BUCKET_NAME,
    Prefix: commandPrefix,
    ContinuationToken: continuationToken
  })

  const listedObjects = await s3Client.send(listCommand)

  if (isArray(listedObjects.Contents) !== true) {
    const message = `Cannot apply function on ${commandPrefix} prefix in bucket ${bucketInfo.BUCKET_NAME}: no files listed.`

    logger.error(message, { response: listedObjects, ...lTags() })
    throw new Error(message)
  }
  if (isPolicymode) {
    await map(listedObjects.Contents, object => {
      return commandBuilder()
    }, { concurrency: 10 })
  } else {
    await map(listedObjects.Contents, object => {
      const command = commandBuilder(object)
      
      return s3Client.send(command)
    }, { concurrency: 10 })
  }
    
  // Repeat if not all objects could be listed at once (limit of 1000?)
  if (listedObjects.IsTruncated) {
    await applyOnPrefix({ ...options, continuationToken: listedObjects.ContinuationToken })
  }
}

function ACLEnabled () {
  return CONFIG.OBJECT_STORAGE.UPLOAD_ACL.ENABLED === true
}

function PolicyEnabled() {
  return CONFIG.OBJECT_STORAGE.BUCKET_POLICY.ENABLED === true
}

function getACL (isPrivate: boolean) {
  return isPrivate
    ? CONFIG.OBJECT_STORAGE.UPLOAD_ACL.PRIVATE
    : CONFIG.OBJECT_STORAGE.UPLOAD_ACL.PUBLIC
}

function getPolicy (isPrivate: boolean) {
  return isPrivate
    ? CONFIG.OBJECT_STORAGE.BUCKET_POLICY.PRIVATE
    : CONFIG.OBJECT_STORAGE.BUCKET_POLICY.PUBLIC
}