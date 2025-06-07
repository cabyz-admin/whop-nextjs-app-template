import { whopApi, verifyUserToken } from "@/lib/whop-api";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import OpenAI from "openai";
import sharp from "sharp";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ experienceId: string }> }
) {
  try {
    const { experienceId } = await params;

    if (!experienceId) {
      return NextResponse.json(
        { error: "Missing experienceId" },
        { status: 400 }
      );
    }

    const headersList = await headers();
    const userToken = await verifyUserToken(headersList);
    if (!userToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const hasAccess = await whopApi.checkIfUserHasAccessToExperience({
      userId: userToken.userId,
      experienceId,
    });

    if (!hasAccess.hasAccessToExperience.hasAccess) {
      return NextResponse.json(
        { error: "Unauthorized, no access" },
        { status: 401 }
      );
    }

    const [publicUser, experience] = await Promise.all([
      whopApi.getUser({
        userId: userToken.userId,
      }),
      prisma.experience.findUnique({
        where: {
          id: experienceId,
        },
      }),
    ]);

    if (!request.body || !experience?.prompt) {
      return NextResponse.json(
        { error: "Image and prompt are required" },
        { status: 400 }
      );
    }

    const originalFile = new File(
      [
        await sharp(await request.clone().arrayBuffer())
          .png()
          .toBuffer(),
      ],
      `${Date.now()}-original.png`,
      {
        type: "image/png",
      }
    );

    // Generate image using DALL-E with prompt
    const response = await openai.images.edit({
      model: "dall-e-2",
      image: originalFile,
      prompt: experience.prompt,
      n: 1,
      size: "1024x1024",
    });

    console.log("Response:", response);

    // Get the URL from the response
    const imageUrl = response.data?.[0]?.url;
    if (!imageUrl) {
      throw new Error("No image data returned from OpenAI");
    }

    // Download the generated image
    const imageResponse = await fetch(imageUrl);
    const generatedImageBuffer = await imageResponse.arrayBuffer();

    const generationId = crypto.randomUUID();

    const [originalFileUploadResponse, uploadResponse] = await Promise.all([
      whopApi.uploadAttachment({
        file: originalFile,
        record: "forum_post",
      }),
      whopApi.uploadAttachment({
        file: new File(
          [generatedImageBuffer],
          `${generationId}-generated.png`,
          {
            type: "image/png",
          }
        ),
        record: "forum_post",
      }),
    ]);

    const whopExperience = await whopApi.getExperience({ experienceId });
    const companyId = whopExperience.experience.company.id;

    const generatedAttachmentId = uploadResponse.directUploadId;
    const originalAttachmentId = originalFileUploadResponse.directUploadId;

    const forum = await whopApi.findOrCreateForum({
      input: { experienceId: experience.id, name: "AI Uploads" },
    });

    const forumId = forum.createForum?.id;

    const post = await whopApi.createForumPost({
      input: {
        forumExperienceId: forumId,
        content: `@${publicUser.publicUser?.username} generated this image with the prompt: "${experience.prompt}"\n\nTry it yourself here: https://whop.com/hub/${companyId}/${experience.id}/app\n\nBefore vs After ⬇️`,
        attachments: [
          { directUploadId: originalAttachmentId },
          { directUploadId: generatedAttachmentId },
        ],
      },
    });

    return NextResponse.json({
      success: true,
      imageUrl: uploadResponse.attachment.source.url,
      postId: post.createForumPost?.id,
    });
  } catch (error) {
    console.error("Error generating image:", error);
    return NextResponse.json(
      { error: "Failed to generate image" },
      { status: 500 }
    );
  }
}