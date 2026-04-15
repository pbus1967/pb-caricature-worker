import express, { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import { fal } from "@fal-ai/client";

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const WORKER_SECRET = process.env.RAILWAY_WORKER_SECRET!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const FAL_API_KEY = process.env.FAL_API_KEY!;

fal.config({ credentials: FAL_API_KEY });

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function authCheck(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers["x-worker-secret"];
  if (secret !== WORKER_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.post("/generate", authCheck, async (req: Request, res: Response) => {
  const { job_id, guest_selfie_url, groom_face_url, bride_face_url, event_id, guest_id } = req.body;

  if (!job_id || !guest_selfie_url || !groom_face_url || !bride_face_url) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  res.json({ status: "accepted", job_id });

  runPipeline({ job_id, guest_selfie_url, groom_face_url, bride_face_url, event_id, guest_id })
    .catch(async (err) => {
      console.error("Pipeline error:", err);
      await supabase
        .from("wedding_photos")
        .update({
          status: "failed",
          stage: "failed",
          error_message: String(err),
          updated_at: new Date().toISOString(),
        })
        .eq("id", job_id);
    });
});

async function runPipeline({ job_id, guest_selfie_url, groom_face_url, bride_face_url, event_id, guest_id }: {
  job_id: string; guest_selfie_url: string; groom_face_url: string;
  bride_face_url: string; event_id: string; guest_id: string;
}) {
  const updateStatus = async (stage: string) => {
    await supabase.from("wedding_photos")
      .update({ status: "processing", stage, updated_at: new Date().toISOString() })
      .eq("id", job_id);
  };

  await supabase.from("wedding_photos")
    .update({ status: "processing", stage: "flux", started_at: new Date().toISOString() })
    .eq("id", job_id);

  const scenes = [
    { prompt: "A Jewish wedding ceremony under a chuppah. The groom and bride stand center, a rabbi holds a ketubah scroll. Photorealistic, warm golden lighting, flowers everywhere." },
    { prompt: "A couple in a luxurious honeymoon hotel room. Romantic setting with rose petals. A surprised third person jumps in from the side. Photorealistic, cinematic." },
    { prompt: "Three people dancing the Hora at a joyful Jewish wedding reception. Colorful lights, celebration, wide smile, hands joined. Photorealistic." },
    { prompt: "A formal wedding family portrait. Groom and bride in center. A third person on the side makes a funny face. Photorealistic, studio lighting." },
  ];

  const baseImages: string[] = [];
  for (const scene of scenes) {
    const result = await fal.run("fal-ai/flux/dev", {
      input: { prompt: scene.prompt, num_images: 1, image_size: "portrait_4_3", num_inference_steps: 28, guidance_scale: 3.5 },
    }) as any;
    baseImages.push(result.images[0].url);
  }

  await updateStatus("couple_swap");
  const coupleSwapped: string[] = [];
  for (let i = 0; i < baseImages.length; i++) {
    const result = await fal.run("fal-ai/easel-ai/advanced-face-swap", {
      input: { base_image_url: baseImages[i], swap_faces: [
        { reference_face_url: groom_face_url, face_index: 0 },
        { reference_face_url: bride_face_url, face_index: 1 },
      ]},
    }) as any;
    coupleSwapped.push(result.image.url);
  }

  await updateStatus("guest_swap");
  const finalImages: string[] = [];
  for (let i = 0; i < coupleSwapped.length; i++) {
    const result = await fal.run("fal-ai/easel-ai/advanced-face-swap", {
      input: { base_image_url: coupleSwapped[i], swap_faces: [
        { reference_face_url: guest_selfie_url, face_index: 2 },
      ]},
    }) as any;
    finalImages.push(result.image.url);
  }

  await supabase.from("wedding_photos").update({
    status: "completed", stage: "done", result_urls: finalImages,
    completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", job_id);
}

app.listen(PORT, () => console.log(`Worker running on port ${PORT}`));
