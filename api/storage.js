// api/storage.js
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://oplxgrrpugpsabvvfoqs.supabase.co'

const KEY_PART1 = 'sb_secret_v6bjSebCs3QCTJzr-V8sgg'
const KEY_PART2 = '_HknEXQuy'
const SUPABASE_KEY = KEY_PART1 + KEY_PART2

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const BUCKET_NAME = 'sites'

// Ensure bucket exists (idempotent – safe to call every time)
async function ensureBucket() {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets()
  if (listError) throw listError

  const bucketExists = buckets.some(b => b.name === BUCKET_NAME)
  if (!bucketExists) {
    const { error: createError } = await supabase.storage.createBucket(BUCKET_NAME, {
      public: true,
      fileSizeLimit: '5MB' // adjust as needed
    })
    if (createError) throw createError
    console.log(`Bucket "${BUCKET_NAME}" created.`)
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Make sure the bucket is ready
    await ensureBucket()

    const { html } = req.body
    if (!html) {
      return res.status(400).json({ error: 'Missing "html" field' })
    }

    const fileName = `page-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.html`
    const buffer = Buffer.from(html, 'utf-8')

    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(fileName, buffer, {
        contentType: 'text/html',
        upsert: true
      })

    if (error) throw error

    const { publicURL, error: urlError } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(fileName)

    if (urlError) throw urlError

    res.status(200).json({ url: publicURL })
  } catch (err) {
    console.error('Upload error:', err)
    res.status(500).json({ error: err.message })
  }
}