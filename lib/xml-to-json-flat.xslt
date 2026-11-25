<?xml version="1.0" encoding="UTF-8"?>
<!--
  Flatten any XML into a single-level JSON record (XSLT 1.0).
  - Root element is dropped; its children become top-level keys
  - Nested elements are joined with "_"        <A><B>x</B></A>       -> "A_B": "x"
  - Repeated siblings get a 1-based index      <L>a</L><L>b</L>      -> "L_1": "a", "L_2": "b"
  - All values are strings, empty elements become null
  - Attributes are ignored; key order follows the XML
-->
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="text" encoding="UTF-8"/>
  <xsl:strip-space elements="*"/>

  <xsl:template match="/">
    <xsl:variable name="root" select="*[1]"/>
    <xsl:text>{</xsl:text>
    <xsl:choose>
      <!-- Root has child elements: flatten them -->
      <xsl:when test="$root/*">
        <xsl:for-each select="$root//*[not(*)]">
          <xsl:if test="position() &gt; 1">,</xsl:if>
          <xsl:text>&#10;    "</xsl:text>
          <xsl:call-template name="escape">
            <xsl:with-param name="s">
              <xsl:for-each select="ancestor-or-self::*[count(ancestor::*) &gt; 0]">
                <xsl:if test="position() &gt; 1">_</xsl:if>
                <xsl:value-of select="name()"/>
                <xsl:variable name="n" select="name()"/>
                <xsl:if test="count(../*[name() = $n]) &gt; 1">
                  <xsl:text>_</xsl:text>
                  <xsl:value-of select="count(preceding-sibling::*[name() = $n]) + 1"/>
                </xsl:if>
              </xsl:for-each>
            </xsl:with-param>
          </xsl:call-template>
          <xsl:text>": </xsl:text>
          <xsl:call-template name="value"/>
        </xsl:for-each>
      </xsl:when>
      <!-- Root with only text -->
      <xsl:otherwise>
        <xsl:for-each select="$root">
          <xsl:text>&#10;    "</xsl:text>
          <xsl:call-template name="escape">
            <xsl:with-param name="s" select="name()"/>
          </xsl:call-template>
          <xsl:text>": </xsl:text>
          <xsl:call-template name="value"/>
        </xsl:for-each>
      </xsl:otherwise>
    </xsl:choose>
    <xsl:text>&#10;}</xsl:text>
  </xsl:template>

  <!-- Value of the current leaf element: string, or null when empty -->
  <xsl:template name="value">
    <xsl:variable name="v" select="normalize-space(.) "/>
    <xsl:choose>
      <xsl:when test="$v = ''">null</xsl:when>
      <xsl:otherwise>
        <xsl:text>"</xsl:text>
        <xsl:call-template name="escape">
          <xsl:with-param name="s" select="."/>
        </xsl:call-template>
        <xsl:text>"</xsl:text>
      </xsl:otherwise>
    </xsl:choose>
  </xsl:template>

  <!-- JSON string escaping: \ " newline carriage-return tab -->
  <xsl:template name="escape">
    <xsl:param name="s"/>
    <xsl:call-template name="replace">
      <xsl:with-param name="s">
        <xsl:call-template name="replace">
          <xsl:with-param name="s">
            <xsl:call-template name="replace">
              <xsl:with-param name="s">
                <xsl:call-template name="replace">
                  <xsl:with-param name="s">
                    <xsl:call-template name="replace">
                      <xsl:with-param name="s" select="$s"/>
                      <xsl:with-param name="from" select="'\'"/>
                      <xsl:with-param name="to" select="'\\'"/>
                    </xsl:call-template>
                  </xsl:with-param>
                  <xsl:with-param name="from" select="'&quot;'"/>
                  <xsl:with-param name="to" select="'\&quot;'"/>
                </xsl:call-template>
              </xsl:with-param>
              <xsl:with-param name="from" select="'&#10;'"/>
              <xsl:with-param name="to" select="'\n'"/>
            </xsl:call-template>
          </xsl:with-param>
          <xsl:with-param name="from" select="'&#13;'"/>
          <xsl:with-param name="to" select="'\r'"/>
        </xsl:call-template>
      </xsl:with-param>
      <xsl:with-param name="from" select="'&#9;'"/>
      <xsl:with-param name="to" select="'\t'"/>
    </xsl:call-template>
  </xsl:template>

  <xsl:template name="replace">
    <xsl:param name="s"/>
    <xsl:param name="from"/>
    <xsl:param name="to"/>
    <xsl:choose>
      <xsl:when test="contains($s, $from)">
        <xsl:value-of select="substring-before($s, $from)"/>
        <xsl:value-of select="$to"/>
        <xsl:call-template name="replace">
          <xsl:with-param name="s" select="substring-after($s, $from)"/>
          <xsl:with-param name="from" select="$from"/>
          <xsl:with-param name="to" select="$to"/>
        </xsl:call-template>
      </xsl:when>
      <xsl:otherwise>
        <xsl:value-of select="$s"/>
      </xsl:otherwise>
    </xsl:choose>
  </xsl:template>
</xsl:stylesheet>
