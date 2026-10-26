import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as os from 'node:os'

const execFileAsync = promisify(execFile)
const MiB = 1024 * 1024

export interface GpuMemory {
  name: string
  totalBytes: number
  freeBytes: number
}

export type HardwareSource = 'nvidia-smi' | 'cpu-only'

export interface HardwareInfo {
  gpuName: string | null
  /** Null when no GPU could be queried — never a guessed number. */
  vramTotalBytes: number | null
  vramFreeBytes: number | null
  ramTotalBytes: number
  ramFreeBytes: number
  source: HardwareSource
}

/**
 * Parse one `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits`
 * row. Values are MiB.
 */
export function parseNvidiaSmi(output: string): GpuMemory | null {
  const line = output.split(/\r?\n/).find((l) => l.trim().length > 0)
  if (!line) return null

  const parts = line.split(',').map((s) => s.trim())
  if (parts.length < 3) return null
  if (!/nvidia|geforce|rtx|gtx|quadro|tesla|titan/i.test(parts[0])) return null

  const total = Number(parts[1])
  const free = Number(parts[2])
  if (!Number.isFinite(total) || !Number.isFinite(free)) return null
  if (total <= 0 || free < 0 || free > total) return null

  return { name: parts[0], totalBytes: total * MiB, freeBytes: free * MiB }
}

/**
 * AMD and Intel expose no `nvidia-smi` equivalent, and WMI's AdapterRAM is a
 * 32-bit field that reports 8 GB cards as 4 GB. Rather than guess and recommend
 * a model that will spill, we fall back to a CPU-only budget and say so.
 */
export function buildHardware(
  smi: string | null,
  ramTotalBytes: number,
  ramFreeBytes: number
): HardwareInfo {
  const gpu = smi ? parseNvidiaSmi(smi) : null

  if (!gpu) {
    return {
      gpuName: null,
      vramTotalBytes: null,
      vramFreeBytes: null,
      ramTotalBytes,
      ramFreeBytes,
      source: 'cpu-only'
    }
  }

  return {
    gpuName: gpu.name,
    vramTotalBytes: gpu.totalBytes,
    vramFreeBytes: gpu.freeBytes,
    ramTotalBytes,
    ramFreeBytes,
    source: 'nvidia-smi'
  }
}

export async function readHardware(): Promise<HardwareInfo> {
  let smi: string | null = null
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true }
    )
    smi = stdout
  } catch {
    smi = null
  }
  return buildHardware(smi, os.totalmem(), os.freemem())
}
