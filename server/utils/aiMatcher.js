const { calculateATSScore } = require('./atsEngine');

/**
 * Clean JSON output from LLM in case it includes markdown backticks
 */
function cleanJsonString(str) {
  if (!str) return '';
  return str.replace(/```json/gi, '').replace(/```/g, '').trim();
}

/**
 * Matches a resume with a job using Gen AI (Google Gemini) or Smart ATS Fallback.
 * @param {Object} job - { id, title, company, description, tags }
 * @param {Object} resume - { id, title, parsed_content }
 * @returns {Promise<Object>}
 */
async function matchResumeWithJob(job, resume) {
  const apiKey = process.env.GEMINI_API_KEY;
  const resumeText = resume.parsed_content || '';
  const jdText = job.description || '';
  const jobTags = Array.isArray(job.tags) ? job.tags : [];

  // If Gemini API Key is configured, attempt Gen AI analysis
  if (apiKey && apiKey.trim().length > 0 && !apiKey.includes('your_gemini_key')) {
    try {
      const prompt = `You are an expert AI Career Advisor and Technical Recruiter for CareerConnect.
Evaluate how well the candidate's resume matches the specified job role.

JOB TITLE: ${job.title}
COMPANY: ${job.company}
REQUIRED SKILLS / TAGS: ${jobTags.join(', ')}
JOB DESCRIPTION:
${jdText.substring(0, 3000)}

CANDIDATE RESUME (${resume.title}):
${resumeText.substring(0, 4000)}

Please provide a JSON response with this EXACT structure:
{
  "score": <number 0-100>,
  "recommendation": <"Strongly Recommended" | "Recommended with Preparation" | "Moderate Match" | "Not Recommended">,
  "shouldApply": <true if score >= 50 else false>,
  "summary": <2-3 sentence clear advice on whether they should apply and why>,
  "matchedSkills": [<strings of skills the candidate matches>],
  "missingSkills": [<strings of key skills or requirements candidate lacks>],
  "keyStrengths": [<1-2 key candidate strengths for this role>],
  "preparationTips": [<1-2 specific suggestions to prepare for this role>]
}
Respond ONLY with the raw JSON object. No explanation, no markdown ticks.`;

      // Gemini 1.5 Flash API endpoint
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
      const response = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json"
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const candidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (candidateText) {
          const parsedResult = JSON.parse(cleanJsonString(candidateText));
          return {
            ...parsedResult,
            source: 'gemini'
          };
        }
      } else {
        const errText = await response.text();
        console.warn('[GenAI Matcher] Gemini API returned error:', response.status, errText);
      }
    } catch (geminiErr) {
      console.warn('[GenAI Matcher] Gemini call failed, falling back to smart ATS engine:', geminiErr.message);
    }
  }

  // --- SMART HEURISTIC / ATS ENGINE FALLBACK ---
  // Works immediately without needing an external API key
  const { score: rawAtsScore, matchedKeywords, missingKeywords } = calculateATSScore(resumeText, jdText, jobTags);

  // If resume is empty, penalize heavily
  const hasContent = resumeText.trim().length > 50;
  const score = hasContent ? Math.max(20, rawAtsScore) : 20;

  let recommendation = 'Not Recommended (Significant Skill Gaps)';
  let shouldApply = false;
  let summary = '';

  if (!hasContent) {
    recommendation = 'Not Recommended (Empty Resume)';
    summary = 'Your chosen resume contains very little or no readable text. Please choose a complete resume or re-upload your resume with selectable text.';
  } else if (score >= 75) {
    recommendation = 'Strongly Recommended';
    shouldApply = true;
    summary = `Your profile shows excellent compatibility with the ${job.title} role at ${job.company}. You have demonstrated hands-on capability in key required areas.`;
  } else if (score >= 50) {
    recommendation = 'Recommended with Preparation';
    shouldApply = true;
    summary = `You have a good foundational match for ${job.title}. While you cover essential concepts, you should review the listed missing skills before interviewing.`;
  } else {
    recommendation = 'Moderate Match (Gaps in Core Requirements)';
    shouldApply = false;
    summary = `Your resume currently matches only a subset of the required skills for ${job.title}. We recommend tailoring your resume or upskilling in the missing technologies before applying.`;
  }

  const matchedSkills = matchedKeywords.slice(0, 8);
  const missingSkills = missingKeywords.slice(0, 6);

  return {
    score,
    recommendation,
    shouldApply,
    summary,
    matchedSkills: matchedSkills.length > 0 ? matchedSkills : ['General technical knowledge'],
    missingSkills: missingSkills.length > 0 ? missingSkills : ['No major skill gaps detected'],
    keyStrengths: [
      matchedSkills.length > 0 ? `Relevant experience with ${matchedSkills.slice(0, 3).join(', ')}` : 'Document formatting and structure',
      'Hands-on full-stack or software project background'
    ],
    preparationTips: [
      missingSkills.length > 0 ? `Review concepts related to: ${missingSkills.slice(0, 3).join(', ')}` : 'Prepare talking points on your recent projects',
      `Align your interview answers with ${job.company}'s core business focus`
    ],
    source: 'built-in'
  };
}

module.exports = {
  matchResumeWithJob
};
