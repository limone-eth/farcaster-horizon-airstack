import { NextRequest, NextResponse } from "next/server";
import { FrameActionPayload, getAddressForFid, getFrameHtml } from "frames.js";
import { NFT_COLLECTION_ADDRESS, SUPPLY_LIMIT } from "../../../lib/constants";
import { generateImageSvg } from "../../../lib/svg";
import sharp from "sharp";
import { mintTo } from "../../../lib/thirdweb-engine";
import { isAddressEligible } from "../../../lib/mint-gating";
import { validateFrameMessageWithNeynar } from "../../../lib/neynar";
import {
  NOT_ELIGIBLE_RESPONSE,
  SOLD_OUT_RESPONSE,
  SUCCESS_RESPONSE,
  TRY_AGAIN_RESPONSE,
} from "../../../lib/frame-utils";
import { fetchNftTokenBalance } from "../../../lib/airstack/token-balance";
import {
  deleteCaptchaChallenge,
  validateCaptchaChallenge,
} from "../../../lib/captcha";

async function getResponse(req: NextRequest): Promise<NextResponse> {
  let accountAddress: string | undefined;
  const { searchParams } = new URL(req.url);
  const captchaId = searchParams.get("id");
  const result = searchParams.get("result");

  if (!captchaId || !result) {
    return new NextResponse(TRY_AGAIN_RESPONSE);
  }
  const isCaptchaValid = await validateCaptchaChallenge(
    captchaId,
    parseInt(result)
  );
  if (!isCaptchaValid) {
    return new NextResponse(TRY_AGAIN_RESPONSE);
  }
  await deleteCaptchaChallenge(captchaId);
  try {
    const body: FrameActionPayload = await req.json();
    const { valid: isValid, action } = await validateFrameMessageWithNeynar(
      body.trustedData.messageBytes
    );
    if (!isValid) {
      return new NextResponse(TRY_AGAIN_RESPONSE);
    }

    console.time("getAddressFromFid");
    const fid = action?.interactor.fid;
    accountAddress = await getAddressForFid({
      fid: fid!,
      options: {
        fallbackToCustodyAddress: true,
        hubRequestOptions: {
          headers: { api_key: process.env.NEYNAR_API_KEY! },
        },
      },
    });
    console.timeEnd("getAddressFromFid");

    console.time("isAddressEligible");
    const { farcasterProfile, isEligible } = await isAddressEligible(
      accountAddress!,
      fid!.toString()
    );
    console.log({ farcasterProfile, isEligible });
    console.timeEnd("isAddressEligible");

    if (!isEligible) {
      console.error(`${accountAddress} is not eligible`);
      return new NextResponse(NOT_ELIGIBLE_RESPONSE);
    }

    const { profileHandle: username } = farcasterProfile!;

    console.time("supply and balance checks");
    const { balance, totalSupply } = await fetchNftTokenBalance(
      `fc_fid:${fid}`,
      NFT_COLLECTION_ADDRESS
    );
    console.log({ balance, totalSupply });
    console.timeEnd("supply and balance checks");
    if (parseInt(totalSupply as string) >= SUPPLY_LIMIT) {
      console.error("Sold out");
      return new NextResponse(SOLD_OUT_RESPONSE);
    }

    if (parseInt(balance as string) > 0) {
      console.error("Already minted");
      return new NextResponse(SUCCESS_RESPONSE);
    }

    const svg = await generateImageSvg(fid!.toString(), username!);
    const image = await sharp(Buffer.from(svg)).toFormat("png").toBuffer();

    console.time("mintTo");
    await mintTo(accountAddress!, username!, image);
    console.timeEnd("mintTo");

    return new NextResponse(SUCCESS_RESPONSE);
  } catch (e) {
    return new NextResponse(TRY_AGAIN_RESPONSE);
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  return getResponse(req);
}

export const dynamic = "force-dynamic";
