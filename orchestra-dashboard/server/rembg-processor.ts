import { existsSync, copyFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findComfyInstallation } from './comfy.js';

const execFileAsync = promisify(execFile);

/**
 * Preprocesses a 2D image for TripoSR neural 3D reconstruction:
 * 1. Strips background using rembg (if available) or existing alpha-channel transparency.
 * 2. Centers foreground subject and normalizes bounding box with standard 15% margin.
 * 3. Composites foreground onto neutral 50% gray background (RGB: 128, 128, 128) as required by TripoSR.
 */
export async function preprocessImageForTripo(
  inputImagePath: string,
  outputImagePath: string
): Promise<{ success: boolean; backgroundRemoved: boolean; error?: string }> {
  if (!existsSync(inputImagePath)) {
    throw new Error(`Input image file does not exist at ${inputImagePath}`);
  }

  const installation = findComfyInstallation();
  const pythonPath = installation?.pythonPath || (process.platform === 'win32' ? 'python.exe' : 'python3');

  const pyScript = `
import sys
import json
from PIL import Image
import numpy as np

input_path = ${JSON.stringify(inputImagePath)}
output_path = ${JSON.stringify(outputImagePath)}

try:
    img = Image.open(input_path)
    has_rembg = False
    
    try:
        from rembg import remove
        img = remove(img)
        has_rembg = True
    except Exception as rembg_err:
        pass

    # Convert to RGBA
    if img.mode != 'RGBA':
        img = img.convert('RGBA')

    # Find alpha bounding box
    np_img = np.array(img)
    alpha = np_img[:, :, 3]
    
    # Check if alpha is fully opaque (meaning no background was removed)
    is_fully_opaque = bool(np.all(alpha == 255))
    
    if not has_rembg and is_fully_opaque:
        # Cannot isolate silhouette from an opaque background without rembg
        print(json.dumps({
            'success': False,
            'backgroundRemoved': False,
            'error': 'rembg neural background remover is not installed. Cannot isolate subject from opaque background.'
        }))
        sys.exit(0)

    bbox = Image.fromarray(alpha).getbbox()
    
    if bbox:
        # Crop to subject
        cropped = img.crop(bbox)
        
        # Create standard square canvas (512x512) with 50% neutral gray (128, 128, 128)
        canvas_size = 512
        canvas = Image.new('RGBA', (canvas_size, canvas_size), (128, 128, 128, 255))
        
        # Scale foreground to fit with 15% margin (approx 420px max dimension)
        target_size = int(canvas_size * 0.82)
        w, h = cropped.size
        scale = target_size / max(w, h)
        new_w, new_h = max(1, int(w * scale)), max(1, int(h * scale))
        resized = cropped.resize((new_w, new_h), Image.Resampling.LANCZOS)
        # Clean alpha mask: threshold soft alpha fringes to prevent TripoSR volumetric fog
        alpha_arr = np.array(resized)[:, :, 3]
        clean_alpha = np.where(alpha_arr > 110, 255, 0).astype(np.uint8)
        resized.putalpha(Image.fromarray(clean_alpha))

        # Paste centered
        offset_x = (canvas_size - new_w) // 2
        offset_y = (canvas_size - new_h) // 2
        canvas.paste(resized, (offset_x, offset_y), resized)
        
        final_img = canvas.convert('RGB')
        final_img.save(output_path, 'PNG')
    else:
        # Fallback: paste directly on gray canvas
        canvas = Image.new('RGB', img.size, (128, 128, 128))
        canvas.paste(img, (0, 0), img if img.mode == 'RGBA' else None)
        canvas.save(output_path, 'PNG')

    print(json.dumps({'success': True, 'backgroundRemoved': has_rembg}))
except Exception as e:
    print(json.dumps({'success': False, 'error': str(e)}))
    sys.exit(1)
`;

  try {
    const { stdout } = await execFileAsync(pythonPath, ['-c', pyScript]);
    const lastLine = stdout.trim().split('\n').pop() || '{}';
    const parsed = JSON.parse(lastLine);
    if (!parsed.success && parsed.error) {
      // If rembg was missing on an opaque image, copy fallback but fail truthfully
      copyFileSync(inputImagePath, outputImagePath);
      return {
        success: false,
        backgroundRemoved: false,
        error: parsed.error,
      };
    }
    return {
      success: Boolean(parsed.success),
      backgroundRemoved: Boolean(parsed.backgroundRemoved),
      error: parsed.error,
    };
  } catch (err) {
    console.warn(`[preprocessImageForTripo] Error during alpha preprocessing: ${err instanceof Error ? err.message : String(err)}`);
    copyFileSync(inputImagePath, outputImagePath);
    return {
      success: false,
      backgroundRemoved: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
