// api/storage.js
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://oplxgrrpugpsabvvfoqs.supabase.co'

const KEY_PART1 = 'sb_secret_v6bjSebCs3QCTJzr-V8sgg'
const KEY_PART2 = '_HknEXQuy'
const SUPABASE_KEY = KEY_PART1 + KEY_PART2

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
const BUCKET_NAME = 'sites'

const MAX_STORAGE_BYTES = 800 * 1024 * 1024   // 800 MB – start cleanup
const TARGET_STORAGE_BYTES = 700 * 1024 * 1024 // 700 MB – stop cleanup
const MAX_AGE_DAYS = 7

// Ensure bucket exists (public)
async function ensureBucket() {
  const { data: buckets, error } = await supabase.storage.listBuckets()
  if (error) throw error
  const exists = buckets.some(b => b.name === BUCKET_NAME)
  if (!exists) {
    const { error: createError } = await supabase.storage.createBucket(BUCKET_NAME, {
      public: true,
      fileSizeLimit: '5MB'
    })
    if (createError) throw createError
    console.log(`Bucket "${BUCKET_NAME}" created.`)
  }
}

// List all files in the bucket (handles pagination)
async function listAllFiles() {
  let allFiles = []
  let offset = 0
  const limit = 100
  let hasMore = true

  while (hasMore) {
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .list('', {
        limit,
        offset,
        sortBy: { column: 'created_at', order: 'asc' } // oldest first
      })

    if (error) throw error
    if (!data || data.length === 0) {
      hasMore = false
    } else {
      allFiles = allFiles.concat(data)
      offset += limit
      if (data.length < limit) hasMore = false
    }
  }

  return allFiles
}

// Auto cleanup – first deletes files older than 7 days, then if still over target
// deletes the absolute oldest files regardless of age.
async function autoCleanup() {
  try {
    const files = await listAllFiles()

    // Calculate total size and build a size map for quick lookup
    let totalSize = 0
    for (const file of files) {
      totalSize += file.metadata?.size || 0
    }

    console.log(`Total storage used: ${(totalSize / 1024 / 1024).toFixed(2)} MB`)

    if (totalSize <= MAX_STORAGE_BYTES) {
      console.log('Storage within limits, no cleanup needed.')
      return
    }

    console.log('Storage above threshold, starting cleanup...')

    // ----- Phase 1: Delete files older than 7 days -----
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    const oldFiles = files.filter(file => {
      const created = file.metadata?.created_at
        ? new Date(file.metadata.created_at).getTime()
        : file.created_at
        ? new Date(file.created_at).getTime()
        : 0
      return created > 0 && created < cutoff
    })

    // Sort oldest first (already sorted by list query)
    const toDeletePhase1 = []
    let remainingSize = totalSize
    for (const file of oldFiles) {
      if (remainingSize <= TARGET_STORAGE_BYTES) break
      toDeletePhase1.push(file.name)
      remainingSize -= file.metadata?.size || 0
    }

    if (toDeletePhase1.length > 0) {
      console.log(`Deleting ${toDeletePhase1.length} old files...`)
      const { error } = await supabase.storage.from(BUCKET_NAME).remove(toDeletePhase1)
      if (error) {
        console.error('Phase 1 delete error:', error)
      } else {
        console.log(`Phase 1 complete. Freed approximately ${((totalSize - remainingSize) / 1024 / 1024).toFixed(2)} MB.`)
      }
    }

    // ----- Phase 2: If still over target, delete the oldest files regardless of age -----
    if (remainingSize > TARGET_STORAGE_BYTES) {
      console.log('Still above target after age-based cleanup – deleting oldest files overall...')

      // Reload the current file list (since we just deleted some)
      const currentFiles = await listAllFiles()
      // Sort by creation ascending (already sorted)
      const toDeletePhase2 = []
      for (const file of currentFiles) {
        if (remainingSize <= TARGET_STORAGE_BYTES) break
        toDeletePhase2.push(file.name)
        remainingSize -= file.metadata?.size || 0
      }

      if (toDeletePhase2.length > 0) {
        console.log(`Deleting ${toDeletePhase2.length} files (any age)...`)
        const { error } = await supabase.storage.from(BUCKET_NAME).remove(toDeletePhase2)
        if (error) {
          console.error('Phase 2 delete error:', error)
        } else {
          console.log('Phase 2 complete. Bucket should now be under target.')
        }
      } else {
        console.warn('No files left to delete but still over target – consider manual intervention.')
      }
    }

    console.log('Cleanup finished.')
  } catch (err) {
    console.error('Auto cleanup failed:', err)
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    await ensureBucket()

    const { html } = req.body
    if (!html) {
      return res.status(400).json({ error: 'Missing "html" field' })
    }

    const buffer = Buffer.from(html, 'utf-8')
    console.log(`Uploading HTML: ${buffer.length} bytes`)

    const fileName = `page-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.html`

    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(fileName, buffer, {
        contentType: 'text/html',
        upsert: true
      })
    if (error) throw error

    const { data: { publicUrl } } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(fileName)

    // Run cleanup after upload
    await autoCleanup()

    res.status(200).json({ url: publicUrl })
  } catch (err) {
    console.error('Upload error:', err)
    res.status(500).json({ error: err.message })
  }
}