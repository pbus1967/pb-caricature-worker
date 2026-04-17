import express, { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const WORKER_SECRET = process.env.RAILWAY_WORKER_SECRET!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const FAL_API_KEY = process.env.FAL_API_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SCENE_PROMPTS: Record<string, string> = {
  chuppah:
    "A Jewish wedding ceremony under a chuppah. The groom and bride stand center, a rabbi holds a ketubah scroll. Photorealistic, warm golden lighting, flowers everywhere.",
  honeymoon:
    "A couple in a luxurious honeymoon hotel room. Romantic setting with rose petals. A surprised third person jumps in from the side. Photorealistic, cinematic.",
  hora:
    "Three people dancing the Hora at a joyful Jewish wedding reception. Colorful lights, celebration, wide smile, hands joined. Photorealistic.",
  family:
    "A formal wedding family portrait. Groom and bride in center. A third person on the side makes a funny face. Photorealistic, studio lighting.",
};

async function falRun(model: string, input: any): Promise<any> {
  console.log("falRun start", { model, input });

  const res = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${FAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  console.log("falRun response status", { model, status: res.status });

  if (!res.ok) {
    const text = await res.text();
    console.error("falRun failed", { model, status: res.status, text });
    throw new Error(`fal.run error for ${model}: ${text}`);
  }

  const data = await res.json();
  console.log("falRun success", { model, data });
  return data;
}

function authCheck(req: Request, res: Response, next: NextFunction) {
  const secret = req.headers["x-worker-secret"];
  if (secret !== WORKER_SECRET) {
    console.error("Unauthorized request", {
      receivedSecret: secret,
      expectedExists: Boolean(WORKER_SECRET),
    });
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/generate", authCheck, async (req: Request, res: Response) => {
  console.log("START REQUEST");
  console.log("BODY:", req.body);

  const {
    guest_id,
    guest_selfie_url,
    groom_face_url,
    bride_face_url,
    scene_key,
  } = req.body;

  console.log("Parsed fields", {
    guest_id,
    guest_selfie_url,
    groom_face_url,
    bride_face_url,
    scene_key,
  });

  if (!guest_id || !guest_selfie_url || !groom_face_url || !bride_face_url || !scene_key) {
    console.error("Missing required fields", {
      guest_id,
      guest_selfie_url,
      groom_face_url,
      bride_face_url,
      scene_key,
    });
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  if (!SCENE_PROMPTS[scene_key]) {
    console.error("Invalid scene_key", { scene_key });
    res.status(400).json({ error: "Invalid scene_key" });
    return;
  }

  res.json({ status: "accepted", guest_id, scene_key });

  runPipeline({
    guest_id,
    guest_selfie_url,
    groom_face_url,
    bride_face_url,
    scene_key,
  }).catch(async (err) => {
    console.error("Pipeline error:", err);

    await supabase
      .from("wedding_photos")
      .update({
        status: "failed",
        stage: "failed",
        error_message: String(err),
        updated_at: new Date().toISOString(),
      })
      .eq("guest_id", guest_id);
  });
});

async function runPipeline({
  guest_id,
  guest_selfie_url,
  groom_face_url,
  bride_face_url,
  scene_key,
}: {
  guest_id: string;
  guest_selfie_url: string;
  groom_face_url: string;
  bride_face_url: string;
  scene_key: string;
}) {
  console.log("runPipeline start", {
    guest_id,
    scene_key,
    guest_selfie_url,
    groom_face_url,
    bride_face_url,
  });

  const updateStatus = async (stage: string) => {
    console.log("Updating status", { guest_id, stage });

    const { error } = await supabase
      .from("wedding_photos")
      .update({
        status: "processing",
        stage,
        updated_at: new Date().toISOString(),
      })
      .eq("guest_id", guest_id);

    if (error) {
      console.error("updateStatus error", { guest_id, stage, error });
      throw error;
    }
  };

  await updateStatus("flux");

  const prompt = SCENE_PROMPTS[scene_key];
  console.log("Before FAL call. FLUX", { prompt });

  const baseResult = await falRun("fal-ai/flux/dev", {
    prompt,
    num_images: 1,
    image_size: "portrait_4_3",
    num_inference_steps: 28,
    guidance_scale: 3.5,
  });

  console.log("After FAL call. FLUX", { baseResult });

  const baseImageUrl = baseResult?.images?.[0]?.url;
  if (!baseImageUrl) {
    throw new Error("FLUX did not return a base image URL");
  }

  await updateStatus("couple_swap");

  console.log("Before FAL call. couple_swap", {
    baseImageUrl,
    groom_face_url,
    bride_face_url,
  });

  const coupleSwapResult = await falRun("fal-ai/easel-ai/advanced-face-swap", {
    base_image_url: baseImageUrl,
    swap_faces: [
      { reference_face_url: groom_face_url, face_index: 0 },
      { reference_face_url: bride_face_url, face_index: 1 },
    ],
  });

  console.log("After FAL call. couple_swap", { coupleSwapResult });

  const coupleImageUrl = coupleSwapResult?.image?.url;
  if (!coupleImageUrl) {
    throw new Error("Couple swap did not return an image URL");
  }

  await updateStatus("guest_swap");

  console.log("Before FAL call. guest_swap", {
    coupleImageUrl,
    guest_selfie_url,
  });

  const guestSwapResult = await falRun("fal-ai/easel-ai/advanced-face-swap", {
    base_image_url: coupleImageUrl,
    swap_faces: [{ reference_face_url: guest_selfie_url, face_index: 2 }],
  });

  console.log("After FAL call. guest_swap", { guestSwapResult });

  const finalImageUrl = guestSwapResult?.image?.url;
  if (!finalImageUrl) {
    throw new Error("Guest swap did not return a final image URL");
  }

  console.log("Loading existing image_urls", { guest_id });

  const { data: existingRow, error: selectError } = await supabase
    .from("wedding_photos")
    .select("image_urls")
    .eq("guest_id", guest_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selectError) {
    console.error("Failed to load existing image_urls", { guest_id, selectError });
    throw selectError;
  }

  const currentImages = Array.isArray(existingRow?.image_urls)
    ? existingRow.image_urls.filter(Boolean)
    : [];

  const updatedImages = [...currentImages, finalImageUrl];

  console.log("Saving final image_urls", {
    guest_id,
    currentImages,
    finalImageUrl,
    updatedImages,
  });

  const { error: finalUpdateError } = await supabase
    .from("wedding_photos")
    .update({
      status: "completed",
      stage: "done",
      image_urls: updatedImages,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("guest_id", guest_id);

  if (finalUpdateError) {
    console.error("Failed saving final result", { guest_id, finalUpdateError });
    throw finalUpdateError;
  }

  console.log(`Job completed successfully for guest_id=${guest_id}, scene_key=${scene_key}`);
}

app.listen(PORT, () => {
  console.log(`Worker running on port ${PORT}`);
});
