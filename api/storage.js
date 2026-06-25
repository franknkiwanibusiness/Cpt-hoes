// api/storage.js
import { createClient } from '@supabase/supabase-js'

// Hardcoded for testing - replace with env vars in production
const SUPABASE_URL = 'https://oplxgrrpugpsabvvfoqs.supabase.co'
const SUPABASE__KEY = 'sb__v6bjSebCs3QCTJzr-V8sgg_HknEXQuy'

const supabase = createClient(SUPABASE_URL, SUPABASE__KEY)

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { html } = req.body
    if (!html) {
      return res.status(400).json({ error: 'Missing "html" field' })
    }

    // Generate unique filename
    const fileName = `page-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.html`

    // Convert HTML string to Buffer
    const buffer = Buffer.from(html, 'utf-8')

    // Upload to Supabase Storage (bucket must be named 'sites' and public)
    const { data, error } = await supabase.storage
      .from('sites')
      .upload(fileName, buffer, {
        contentType: 'text/html',
        upsert: true
      })

    if (error) throw error

    // Get public URL
    const { publicURL, error: urlError } = supabase.storage
      .from('sites')
      .getPublicUrl(fileName)

    if (urlError) throw urlError

    res.status(200).json({ url: publicURL })
  } catch (err) {
    console.error('Upload error:', err)
    res.status(500).json({ error: err.message })
  }
}