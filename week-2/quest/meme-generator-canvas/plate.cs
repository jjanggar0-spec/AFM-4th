using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;

public delegate double CovFn(double x, double y);

public static class Plate
{
    // ---------- canvas ----------
    const int W = 2480, H = 3508;          // A4 @ 300dpi
    const float ML = 200f, MR = 200f;
    const float CX0 = ML, CX1 = W - MR;    // 200 .. 2280
    const float CW = CX1 - CX0;            // 2080

    // ---------- palette (three notes) ----------
    static Color PAPER = Color.FromArgb(231, 225, 212);
    static Color INK   = Color.FromArgb(25, 21, 18);
    static Color MID   = Color.FromArgb(126, 119, 104);
    static Color SPOT  = Color.FromArgb(180, 56, 31);

    static FontFamily FMono, FThin, FSerif;
    static string FONTDIR;

    // ---------- type scale (px em @ 300dpi) ----------
    const float CAP  = 62f;    // masthead
    const float CLIN = 21f;    // clinical caption / section label
    const float TINY = 16f;    // specimen labels, scale bar
    const float VOX  = 76f;    // the one line permitted to feel

    // =====================================================================
    public static string Render(string fontDir, string outPath)
    {
        FONTDIR = fontDir;
        FMono  = LoadFF("GeistMono-Regular.ttf");
        FThin  = LoadFF("Jura-Light.ttf");
        FSerif = LoadFF("InstrumentSerif-Italic.ttf");

        Bitmap bm = new Bitmap(W, H, PixelFormat.Format32bppArgb);
        bm.SetResolution(300f, 300f);
        Graphics g = Graphics.FromImage(bm);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.CompositingQuality = CompositingQuality.Default;   // gamma-corrected blend lightens every DrawImage rect
        g.Clear(PAPER);

        Masthead(g);
        MainField(g);
        FieldCaption(g);
        IterationField(g);
        Footer(g);

        g.Dispose();
        TonerSurface(bm);          // one unified printed surface over everything
        bm.Save(outPath, ImageFormat.Png);
        bm.Dispose();
        return "WROTE " + outPath;
    }

    // =====================================================================
    // MASTHEAD
    // =====================================================================
    static void Masthead(Graphics g)
    {
        Text(g, "XEROGRAPHIC DRIFT", FThin, FontStyle.Regular, CAP, 23f, CX0, 232f, 0, INK, 255);

        float plW = TW(g, "PL. IV", FMono, FontStyle.Regular, 26f, 6.2f);
        Text(g, "PL. IV", FMono, FontStyle.Regular, 26f, 6.2f, CX1, 232f, 2, INK, 235);
        using (SolidBrush sb = new SolidBrush(SPOT))
            g.FillRectangle(sb, CX1 - plW - 38f, 213f, 13f, 13f);

        Hair(g, CX0, 272.5f, CX1, 272.5f, INK, 160, 1.4f);

        Text(g, "PROPAGATION SERIES  —  072 GENERATIONS", FMono, FontStyle.Regular,
             CLIN, 5.2f, CX0, 328f, 0, MID, 255);
        Text(g, "SCREEN 45°  ·  0.76 MM", FMono, FontStyle.Regular,
             CLIN, 5.2f, CX1, 328f, 2, MID, 255);
    }

    // =====================================================================
    // MAIN FIELD  -- the source impression
    // =====================================================================
    const float FY0 = 410f, FY1 = 1970f;      // 4:3 against CW=2080
    const float BAND = 134f;                  // caption bands, top and bottom

    static void MainField(Graphics g)
    {
        float IY0 = FY0 + BAND;   // 544
        float IY1 = FY1 - BAND;   // 1836

        int iw = (int)CW, ih = (int)(IY1 - IY0);   // 2080 x 1292
        double cx = iw / 2.0, cy = 618.0;
        double r = 490.0;
        double scx = cx + 62.0, scy = cy + r + 42.0, srx = 424.0, sry = 52.0;

        double[] L = LightVec(0.0);
        CovFn cov = delegate(double x, double y)
        {
            double sh = Shadow(x, y, scx, scy, srx, sry);
            double ob = Orb(x, y, cx, cy, r, L, 1.0, 0.0);
            return ob > sh ? ob : sh;
        };

        Bitmap orb = Screen(iw, ih, 2, 9.0, 45.0, cov, 0.0, 0.0, 7301, 0.004);
        g.DrawImage(orb, new RectangleF(CX0, IY0, iw, ih));
        orb.Dispose();

        // architecture: frame, band separators, empty caption baselines
        Rect(g, CX0, FY0, CW, FY1 - FY0, INK, 135, 1.4f);
        Hair(g, CX0, IY0, CX1, IY0, INK, 95, 1.0f);
        Hair(g, CX0, IY1, CX1, IY1, INK, 95, 1.0f);
        Hair(g, CX0 + 176f, FY0 + BAND * 0.62f, CX1 - 176f, FY0 + BAND * 0.62f, INK, 46, 1.0f);
        Hair(g, CX0 + 176f, IY1 + BAND * 0.62f, CX1 - 176f, IY1 + BAND * 0.62f, INK, 46, 1.0f);

        Reg(g, CX0 - 54f, FY0 - 54f, INK, 150, 0f);
        Reg(g, CX1 + 54f, FY0 - 54f, SPOT, 175, 1.6f);   // one impression out of true
        Reg(g, CX0 - 54f, FY1 + 54f, INK, 150, 0f);
        Reg(g, CX1 + 54f, FY1 + 54f, INK, 150, 0f);
    }

    static void FieldCaption(Graphics g)
    {
        Text(g, "G-000  ·  SOURCE STATE", FMono, FontStyle.Regular, CLIN, 5.2f,
             CX0, 2016f, 0, MID, 255);

        // scale bar — a true 50 mm at 300 dpi, divided every 10 mm
        const float MM = 300f / 25.4f;                 // 11.811 px per mm
        float bx1 = CX1, bx0 = CX1 - 50f * MM, by = 2008f;
        Hair(g, bx0, by, bx1, by, MID, 215, 1.3f);
        for (int k = 0; k <= 5; k++)
        {
            float tx = bx0 + k * 10f * MM;
            float tl = (k == 0 || k == 5) ? 9f : 5f;
            Hair(g, tx, by - tl, tx, by + tl, MID, k == 0 || k == 5 ? 215 : 150, 1.2f);
        }
        Text(g, "50 MM", FMono, FontStyle.Regular, TINY, 3.4f, bx1, 2046f, 2, MID, 225);
    }

    // =====================================================================
    // ITERATION FIELD  -- the population
    // =====================================================================
    const int COLS = 12, ROWS = 6, NGEN = 72;
    const float GAPX = 26f, GY0 = 2162f, RPITCH = 158f;

    static void IterationField(Graphics g)
    {
        Text(g, "ITERATION FIELD", FMono, FontStyle.Regular, CLIN, 5.2f, CX0, 2090f, 0, INK, 210);
        Text(g, "N = 072", FMono, FontStyle.Regular, CLIN, 5.2f, CX1, 2090f, 2, MID, 255);
        Hair(g, CX0, 2118.5f, CX1, 2118.5f, INK, 110, 1.2f);

        float colW = (CW - GAPX * (COLS - 1)) / COLS;      // 149.5
        float cellH = colW * 0.75f;                        // 112.125

        int[] MUT = new int[] { 17, 41, 63 };

        Random walk = new Random(48271);
        double rot = 0, dx = 0, dy = 0, scl = 1.0, lt = 0;

        for (int gen = 1; gen <= NGEN; gen++)
        {
            rot += Gauss(walk) * 0.34;
            dx  += Gauss(walk) * 0.50;
            dy  += Gauss(walk) * 0.40;
            scl *= (1.0 + Gauss(walk) * 0.0034);
            lt  += Gauss(walk) * 1.15;

            bool mut = Array.IndexOf(MUT, gen) >= 0;
            if (mut)
            {
                double s = Gauss(walk) >= 0 ? 1 : -1;
                rot += 3.4 * s; lt += 12.0 * s; dx += 3.6 * s; scl *= 1.013;
            }

            double t = (double)gen / NGEN;
            double pitch  = 2.85 * (1.0 + 0.020 * gen);
            double K      = 1.0 + 0.0080 * gen;
            double bias   = 0.006 + 0.0009 * gen;
            double drop   = 0.045 * Math.Pow(t, 1.9);
            double jit    = 0.055 * t;
            double floorC = 0.008 + 0.026 * t;
            int specks    = (int)(1 + 11 * Math.Pow(t, 2.4));

            int i = (gen - 1) % COLS, j = (gen - 1) / COLS;
            float x = CX0 + i * (colW + GAPX);
            float y = GY0 + j * RPITCH;

            int cw = (int)Math.Round((double)colW), ch = (int)Math.Round((double)cellH);
            double ocx = cw / 2.0 + dx, ocy = ch / 2.0 + dy, orr = 41.5 * scl;
            double[] L = LightVec(lt);
            double KK = K, BB = bias;

            CovFn cov = delegate(double px, double py)
            {
                return Orb(px, py, ocx, ocy, orr, L, KK, BB);
            };

            Bitmap sp = Screen(cw, ch, 3, pitch, 45.0 + rot, cov, jit, drop, 9000 + gen * 37, floorC);
            if (specks > 0) Specks(sp, 3, specks, 12000 + gen * 13);
            g.DrawImage(sp, new RectangleF(x, y, cw, ch));
            sp.Dispose();

            string lab = "G-" + gen.ToString("000");
            Color lc = mut ? SPOT : MID;
            int la = mut ? 235 : 170;
            Text(g, lab, FMono, FontStyle.Regular, TINY, 2.4f,
                 x + cw / 2f, y + ch + 27f, 1, lc, la);
        }
    }

    // =====================================================================
    // FOOTER
    // =====================================================================
    static void Footer(Graphics g)
    {
        Hair(g, CX0, 3186.5f, CX1, 3186.5f, INK, 110, 1.2f);
        Text(g, "the original is a rumour", FSerif, FontStyle.Italic, VOX, 1.0f,
             CX0, 3292f, 0, INK, 234);
        Text(g, "ORIGIN — UNRECOVERABLE", FMono, FontStyle.Regular, CLIN, 5.2f,
             CX1, 3292f, 2, MID, 255);
    }

    // =====================================================================
    // HALFTONE ENGINE
    // =====================================================================
    static Bitmap Screen(int w, int h, int ss, double pitch, double angleDeg,
                         CovFn cov, double jitter, double dropout, int seed, double minCov)
    {
        Bitmap bm = new Bitmap(w * ss, h * ss, PixelFormat.Format32bppArgb);
        Graphics g = Graphics.FromImage(bm);
        g.Clear(Color.Transparent);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;

        double a = angleDeg * Math.PI / 180.0, ca = Math.Cos(a), sa = Math.Sin(a);
        double diag = Math.Sqrt((double)w * w + (double)h * h);
        int n = (int)(diag / pitch) + 3;
        double ccx = w / 2.0, ccy = h / 2.0;
        Random r = new Random(seed);
        SolidBrush br = new SolidBrush(Color.FromArgb(255, 20, 17, 14));

        for (int i = -n; i <= n; i++)
        {
            for (int j = -n; j <= n; j++)
            {
                double u = i * pitch, v = j * pitch;
                double x = ccx + u * ca - v * sa;
                double y = ccy + u * sa + v * ca;
                if (x < -pitch || x > w + pitch || y < -pitch || y > h + pitch) continue;

                double c = cov(x, y);
                if (c <= minCov) continue;
                if (dropout > 0 && r.NextDouble() < dropout) continue;

                double jx = 0, jy = 0;
                if (jitter > 0)
                {
                    jx = (r.NextDouble() - 0.5) * jitter * pitch;
                    jy = (r.NextDouble() - 0.5) * jitter * pitch;
                }
                if (c > 1) c = 1;
                double rad = 0.5 * pitch * Math.Sqrt(c) * 1.08;
                if (rad < 0.10) continue;

                float px = (float)((x + jx) * ss), py = (float)((y + jy) * ss), pr = (float)(rad * ss);
                g.FillEllipse(br, px - pr, py - pr, pr * 2f, pr * 2f);
            }
        }
        br.Dispose(); g.Dispose();
        return bm;
    }

    static void Specks(Bitmap bm, int ss, int count, int seed)
    {
        Graphics g = Graphics.FromImage(bm);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Random r = new Random(seed);
        int w = bm.Width, h = bm.Height;
        using (SolidBrush b = new SolidBrush(Color.FromArgb(205, 20, 17, 14)))
        {
            for (int i = 0; i < count; i++)
            {
                float x = (float)(r.NextDouble() * w), y = (float)(r.NextDouble() * h);
                float rad = (float)((0.35 + r.NextDouble() * 1.05) * ss);
                g.FillEllipse(b, x - rad, y - rad, rad * 2, rad * 2);
            }
        }
        g.Dispose();
    }

    // ---------- shading ----------
    static double[] LightVec(double driftDeg)
    {
        double t = Math.Atan2(-0.52, -0.45) + driftDeg * Math.PI / 180.0;
        double ce = 0.690, se = 0.724;                 // elevation
        double lx = Math.Cos(t) * ce, ly = Math.Sin(t) * ce, lz = se;
        double m = Math.Sqrt(lx * lx + ly * ly + lz * lz);
        return new double[] { lx / m, ly / m, lz / m };
    }

    static double Orb(double x, double y, double cx, double cy, double r,
                      double[] L, double K, double bias)
    {
        double nx = (x - cx) / r, ny = (y - cy) / r;
        double d2 = nx * nx + ny * ny;
        if (d2 > 1.0) return 0.0;
        double nz = Math.Sqrt(1.0 - d2);

        double diff = nx * L[0] + ny * L[1] + nz * L[2];
        if (diff < 0) diff = 0;
        double lum = 0.055 + 0.900 * Math.Pow(diff, 0.84);

        double bd = nx * 0.52 + ny * 0.60 + nz * 0.15;      // bounce off the ground plane
        if (bd > 0) lum += 0.105 * Math.Pow(bd, 2.2);

        lum *= (1.0 - 0.10 * Math.Pow(d2, 6.0));            // rim turn
        if (lum < 0) lum = 0;
        if (lum > 1) lum = 1;

        double ink = 1.0 - lum;
        ink = (ink - 0.5) * K + 0.5 + bias;
        if (ink < 0) ink = 0;
        if (ink > 1) ink = 1;
        return ink;
    }

    static double Shadow(double x, double y, double cx, double cy, double rx, double ry)
    {
        double sx = (x - cx) / rx, sy = (y - cy) / ry;
        double t = sx * sx + sy * sy;
        if (t >= 1.0) return 0.0;
        double f = 1.0 - t; f = f * f;
        double fade = 1.0 - 0.42 * Math.Max(0.0, sy);
        return 0.40 * f * fade;
    }

    static double Smooth(double t)
    {
        return t * t * (3.0 - 2.0 * t);
    }

    static double Gauss(Random r)
    {
        double u1 = 1.0 - r.NextDouble(), u2 = r.NextDouble();
        return Math.Sqrt(-2.0 * Math.Log(u1)) * Math.Cos(2.0 * Math.PI * u2);
    }

    // =====================================================================
    // TONER SURFACE -- grain, banding, blotch, vignette over the whole plate
    // =====================================================================
    static void TonerSurface(Bitmap bm)
    {
        int w = bm.Width, h = bm.Height;
        Random r = new Random(31337);

        int bw = 9, bh = 13;                       // broad, slow drift across the sheet
        double[,] blot = new double[bh, bw];
        for (int j = 0; j < bh; j++)
            for (int i = 0; i < bw; i++)
                blot[j, i] = Gauss(r) * 1.7;

        BitmapData bd = bm.LockBits(new Rectangle(0, 0, w, h),
            ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        int stride = bd.Stride;
        byte[] buf = new byte[stride * h];
        System.Runtime.InteropServices.Marshal.Copy(bd.Scan0, buf, 0, buf.Length);

        double icx = w / 2.0, icy = h / 2.0;
        double maxd = Math.Sqrt(icx * icx + icy * icy);

        for (int y = 0; y < h; y++)
        {
            double fy = (double)y / h * (bh - 1);
            int j0 = (int)fy;
            int j1 = Math.Min(j0 + 1, bh - 1);
            double tj = Smooth(fy - j0);
            double band = 1.0
                + 0.0042 * Math.Sin(y / 193.0 + 0.7)
                + 0.0021 * Math.Sin(y / 37.0 + 2.1);
            int row = y * stride;

            for (int x = 0; x < w; x++)
            {
                double fx = (double)x / w * (bw - 1);
                int i0 = (int)fx;
                int i1 = Math.Min(i0 + 1, bw - 1);
                double ti = Smooth(fx - i0);
                double b = blot[j0, i0] * (1 - ti) * (1 - tj) + blot[j0, i1] * ti * (1 - tj)
                         + blot[j1, i0] * (1 - ti) * tj + blot[j1, i1] * ti * tj;

                double dx = x - icx, dy = y - icy;
                double vg = -6.4 * Math.Pow(Math.Sqrt(dx * dx + dy * dy) / maxd, 2.6);

                double gr = (r.NextDouble() - 0.5) * 5.8;

                int p = row + x * 4;
                for (int c = 0; c < 3; c++)
                {
                    double v = buf[p + c] * band + b + gr + vg;
                    if (v < 0) v = 0;
                    if (v > 255) v = 255;
                    buf[p + c] = (byte)v;
                }
            }
        }
        System.Runtime.InteropServices.Marshal.Copy(buf, 0, bd.Scan0, buf.Length);
        bm.UnlockBits(bd);
    }

    // =====================================================================
    // TYPOGRAPHY + RULES
    // =====================================================================
    static FontFamily LoadFF(string file)
    {
        PrivateFontCollection p = new PrivateFontCollection();
        p.AddFontFile(System.IO.Path.Combine(FONTDIR, file));
        return p.Families[0];
    }

    static FontStyle Fix(FontFamily f, FontStyle s)
    {
        if (f.IsStyleAvailable(s)) return s;
        FontStyle[] all = new FontStyle[] { FontStyle.Regular, FontStyle.Italic, FontStyle.Bold, FontStyle.Bold | FontStyle.Italic };
        foreach (FontStyle t in all) if (f.IsStyleAvailable(t)) return t;
        return FontStyle.Regular;
    }

    static float PW(Graphics g, string s, Font f)
    {
        if (s.Length == 0) return 0f;
        StringFormat sf = (StringFormat)StringFormat.GenericTypographic.Clone();
        sf.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces;
        float v = g.MeasureString(s, f, PointF.Empty, sf).Width;
        sf.Dispose();
        return v;
    }

    static float TW(Graphics g, string s, FontFamily fam, FontStyle st, float em, float track)
    {
        FontStyle sx = Fix(fam, st);
        using (Font f = new Font(fam, em, sx, GraphicsUnit.Pixel))
            return PW(g, s, f) + track * Math.Max(0, s.Length - 1);
    }

    static void Text(Graphics g, string s, FontFamily fam, FontStyle st, float em,
                     float track, float x, float baseline, int align, Color col, int alpha)
    {
        FontStyle sx = Fix(fam, st);
        using (Font f = new Font(fam, em, sx, GraphicsUnit.Pixel))
        {
            float total = PW(g, s, f) + track * Math.Max(0, s.Length - 1);
            float px = align == 0 ? x : (align == 1 ? x - total / 2f : x - total);
            float asc = fam.GetCellAscent(sx) / (float)fam.GetEmHeight(sx) * em;
            float top = baseline - asc;

            using (GraphicsPath gp = new GraphicsPath())
            {
                float cur = px;
                float prev = 0f;
                for (int i = 0; i < s.Length; i++)
                {
                    string ch = s.Substring(i, 1);
                    if (ch != " ")
                        gp.AddString(ch, fam, (int)sx, em, new PointF(cur, top),
                                     StringFormat.GenericTypographic);
                    float w1 = PW(g, s.Substring(0, i + 1), f);
                    float adv = w1 - prev;
                    prev = w1;
                    cur += adv + track;
                }
                using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, col)))
                    g.FillPath(b, gp);
            }
        }
    }

    static void Hair(Graphics g, float x0, float y0, float x1, float y1, Color c, int a, float w)
    {
        using (Pen p = new Pen(Color.FromArgb(a, c), w))
            g.DrawLine(p, x0, y0, x1, y1);
    }

    static void Rect(Graphics g, float x, float y, float w, float h, Color c, int a, float pw)
    {
        using (Pen p = new Pen(Color.FromArgb(a, c), pw))
            g.DrawRectangle(p, x, y, w, h);
    }

    static void Reg(Graphics g, float x, float y, Color c, int a, float off)
    {
        float s = 17f;
        using (Pen p = new Pen(Color.FromArgb(a, c), 1.1f))
        {
            g.DrawLine(p, x - s + off, y + off, x + s + off, y + off);
            g.DrawLine(p, x + off, y - s + off, x + off, y + s + off);
            g.DrawEllipse(p, x - 7.5f + off, y - 7.5f + off, 15f, 15f);
        }
    }
}
